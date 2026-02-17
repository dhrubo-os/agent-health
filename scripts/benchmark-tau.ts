#!/usr/bin/env node
/**
 * Tau-Bench Style Evaluation for OASIS Chat Agent
 * 
 * Evaluates task-oriented agent performance focusing on:
 * - Tool usage (did agent call the right tools?)
 * - Task completion (did agent achieve the user's goal?)
 * - Accuracy (is the information correct?)
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { writeFileSync } from 'fs';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
dotenv.config({ path: envPath });

interface TauBenchTask {
  id: string;
  category: string;
  user_goal: string;
  initial_query: string;
  expected_tools: string[];
  success_criteria: string;
  evaluation_type: string;
}

interface TaskResult {
  taskId: string;
  category: string;
  query: string;
  toolsUsed: string[];
  expectedTools: string[];
  response: string;
  toolUsageScore: number;
  taskCompletionScore: number;
  overallScore: number;
  reasoning: string;
  latencyMs: number;
}

const CONFIG = {
  oasisEndpoint: process.env.MLCOMMONS_ENDPOINT!,
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  bedrockModel: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  datasetPath: process.env.TAU_DATASET || 'data/tau-bench/opensearch-tasks.json',
  accuracyThreshold: parseInt(process.env.ACCURACY_THRESHOLD || '85'),
  maxTasks: process.env.MAX_TASKS ? parseInt(process.env.MAX_TASKS) : undefined,
};

async function callOasisAgent(query: string): Promise<{ response: string; toolsUsed: string[]; latencyMs: number }> {
  const startTime = Date.now();
  const { signAgentRequest } = await import('../server/services/auth/sigv4Signer.js');
  
  const payload = JSON.stringify({ parameters: { question: query } });
  const sigv4Headers = await signAgentRequest(CONFIG.oasisEndpoint, payload);
  
  const response = await fetch(CONFIG.oasisEndpoint, {
    method: 'POST',
    headers: {
      ...sigv4Headers,
      'Content-Type': 'application/json',
    },
    body: payload,
  });
  
  if (!response.ok || !response.body) {
    throw new Error(`Agent request failed: ${response.status}`);
  }
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let currentMessage = '';
  const toolsUsed: string[] = [];
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            if (data.inference_results?.[0]?.output) {
              const outputs = data.inference_results[0].output;
              const responseOutput = outputs.find((o: any) => o.name === 'response');
              
              if (responseOutput?.dataAsMap?.content) {
                const aguiEvent = JSON.parse(responseOutput.dataAsMap.content);
                
                // Track tool usage
                if (aguiEvent.type === 'TOOL_CALL_START' && aguiEvent.toolCallName) {
                  toolsUsed.push(aguiEvent.toolCallName);
                }
                
                // Collect text
                if (aguiEvent.type === 'TEXT_MESSAGE_CONTENT' && aguiEvent.delta) {
                  currentMessage += aguiEvent.delta;
                } else if (aguiEvent.type === 'TEXT_MESSAGE_END') {
                  fullResponse += currentMessage;
                  currentMessage = '';
                }
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  
  const latencyMs = Date.now() - startTime;
  return { response: fullResponse, toolsUsed, latencyMs };
}

async function evaluateTask(task: TauBenchTask, agentResponse: string, toolsUsed: string[]): Promise<{ toolUsageScore: number; taskCompletionScore: number; reasoning: string }> {
  const client = new BedrockRuntimeClient({ region: CONFIG.awsRegion });
  
  const judgePrompt = `You are evaluating an OpenSearch agent's performance on a task-oriented query.

**User Goal:** ${task.user_goal}
**User Query:** ${task.initial_query}
**Success Criteria:** ${task.success_criteria}

**Expected Tools:** ${task.expected_tools.join(', ')}
**Tools Actually Used:** ${toolsUsed.length > 0 ? toolsUsed.join(', ') : 'None'}

**Agent Response:**
${agentResponse}

Evaluate the agent on two dimensions:

1. **Tool Usage (0-100):** Did the agent use the expected tools? Score 100 if all expected tools were used, 0 if none were used, proportional otherwise.

2. **Task Completion (0-100):** Did the agent achieve the user's goal based on the success criteria? Consider:
   - Did it provide the requested information?
   - Is the response relevant and helpful?
   - Does it meet the success criteria?

Respond in JSON format:
{
  "tool_usage_score": <0-100>,
  "task_completion_score": <0-100>,
  "reasoning": "<brief explanation of scores>"
}`;

  const command = new ConverseCommand({
    modelId: CONFIG.bedrockModel,
    messages: [{ role: 'user', content: [{ text: judgePrompt }] }],
    inferenceConfig: { temperature: 0, maxTokens: 1000 },
  });
  
  const result = await client.send(command);
  const judgeResponse = result.output?.message?.content?.[0]?.text || '{}';
  
  try {
    const scores = JSON.parse(judgeResponse);
    return {
      toolUsageScore: scores.tool_usage_score || 0,
      taskCompletionScore: scores.task_completion_score || 0,
      reasoning: scores.reasoning || 'No reasoning provided',
    };
  } catch (e) {
    console.error('Failed to parse judge response:', judgeResponse);
    return { toolUsageScore: 0, taskCompletionScore: 0, reasoning: 'Judge evaluation failed' };
  }
}

async function main() {
  console.log('🚀 Starting Tau-Bench Style Evaluation...\n');
  console.log(`Dataset: ${CONFIG.datasetPath}`);
  console.log(`Endpoint: ${CONFIG.oasisEndpoint}`);
  console.log(`Threshold: ${CONFIG.accuracyThreshold}%\n`);
  
  // Load tasks
  const tasksPath = path.join(projectRoot, CONFIG.datasetPath);
  const tasks: TauBenchTask[] = JSON.parse(readFileSync(tasksPath, 'utf-8'));
  const tasksToRun = CONFIG.maxTasks ? tasks.slice(0, CONFIG.maxTasks) : tasks;
  
  console.log(`Loaded ${tasksToRun.length} tasks\n`);
  
  const results: TaskResult[] = [];
  
  for (let i = 0; i < tasksToRun.length; i++) {
    const task = tasksToRun[i];
    console.log(`[${i + 1}/${tasksToRun.length}] Evaluating: ${task.category}`);
    console.log(`  Query: ${task.initial_query}\n`);
    
    // Call agent
    const { response, toolsUsed, latencyMs } = await callOasisAgent(task.initial_query);
    
    // Evaluate
    const { toolUsageScore, taskCompletionScore, reasoning } = await evaluateTask(task, response, toolsUsed);
    const overallScore = (toolUsageScore + taskCompletionScore) / 2;
    
    console.log(`  ✓ Tools Used: ${toolsUsed.length > 0 ? toolsUsed.join(', ') : 'None'}`);
    console.log(`  ✓ Tool Usage Score: ${toolUsageScore}/100`);
    console.log(`  ✓ Task Completion Score: ${taskCompletionScore}/100`);
    console.log(`  ✓ Overall Score: ${overallScore}/100 (${latencyMs}ms)`);
    console.log(`  Reasoning: ${reasoning}\n`);
    
    results.push({
      taskId: task.id,
      category: task.category,
      query: task.initial_query,
      toolsUsed,
      expectedTools: task.expected_tools,
      response,
      toolUsageScore,
      taskCompletionScore,
      overallScore,
      reasoning,
      latencyMs,
    });
  }
  
  // Calculate metrics
  const avgToolUsage = results.reduce((sum, r) => sum + r.toolUsageScore, 0) / results.length;
  const avgTaskCompletion = results.reduce((sum, r) => sum + r.taskCompletionScore, 0) / results.length;
  const avgOverall = results.reduce((sum, r) => sum + r.overallScore, 0) / results.length;
  const passRate = (results.filter(r => r.overallScore >= CONFIG.accuracyThreshold).length / results.length) * 100;
  
  // By category
  const byCategory: Record<string, { toolUsage: number; taskCompletion: number; overall: number; count: number }> = {};
  for (const result of results) {
    if (!byCategory[result.category]) {
      byCategory[result.category] = { toolUsage: 0, taskCompletion: 0, overall: 0, count: 0 };
    }
    byCategory[result.category].toolUsage += result.toolUsageScore;
    byCategory[result.category].taskCompletion += result.taskCompletionScore;
    byCategory[result.category].overall += result.overallScore;
    byCategory[result.category].count++;
  }
  
  for (const category in byCategory) {
    const stats = byCategory[category];
    stats.toolUsage /= stats.count;
    stats.taskCompletion /= stats.count;
    stats.overall /= stats.count;
  }
  
  // Print results
  console.log('\n============================================================');
  console.log('📊 TAU-BENCH STYLE RESULTS');
  console.log('============================================================\n');
  console.log(`Total Tasks: ${results.length}`);
  console.log(`Average Tool Usage Score: ${avgToolUsage.toFixed(2)}%`);
  console.log(`Average Task Completion Score: ${avgTaskCompletion.toFixed(2)}%`);
  console.log(`Average Overall Score: ${avgOverall.toFixed(2)}%`);
  console.log(`Pass Rate (≥${CONFIG.accuracyThreshold}%): ${passRate.toFixed(2)}%\n`);
  
  console.log('By Category:');
  for (const category in byCategory) {
    const stats = byCategory[category];
    console.log(`  ${category}:`);
    console.log(`    Tool Usage: ${stats.toolUsage.toFixed(2)}%`);
    console.log(`    Task Completion: ${stats.taskCompletion.toFixed(2)}%`);
    console.log(`    Overall: ${stats.overall.toFixed(2)}% (${stats.count} tasks)`);
  }
  
  console.log('\n============================================================');
  if (passRate >= CONFIG.accuracyThreshold) {
    console.log('✅ PASSED');
  } else {
    console.log('❌ FAILED');
  }
  console.log('============================================================\n');
  
  // Save report
  const reportPath = path.join(projectRoot, 'tau-benchmark-report.json');
  const report = {
    totalTasks: results.length,
    averageToolUsage: avgToolUsage,
    averageTaskCompletion: avgTaskCompletion,
    averageOverall: avgOverall,
    passRate,
    byCategory,
    results,
  };
  
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`📄 Report saved to: ${reportPath}\n`);
  
  process.exit(passRate >= CONFIG.accuracyThreshold ? 0 : 1);
}

main().catch(console.error);
