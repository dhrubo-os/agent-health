/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MT-Bench Benchmarking Script
 * 
 * Evaluates OASIS agent accuracy using MT-Bench dataset
 * Usage: npm run benchmark:mtbench
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import dotenv from 'dotenv';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// When bundled, we're in scripts/dist/, so go up two levels to project root
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
dotenv.config({ path: envPath });

// ============================================================================
// Types
// ============================================================================

interface MTBenchQuestion {
  question_id: number;
  category: string;
  turns: string[];
  reference?: string;
}

interface BenchmarkResult {
  questionId: number;
  category: string;
  query: string;
  expected: string;
  actual: string;
  accuracyScore: number;
  reasoning: string;
  latencyMs: number;
}

interface BenchmarkSummary {
  totalQuestions: number;
  averageAccuracy: number;
  passRate: number;
  byCategory: Record<string, { accuracy: number; count: number }>;
  results: BenchmarkResult[];
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  datasetPath: process.env.MTBENCH_DATASET || 'data/mtbench/sample-questions.json',
  oasisEndpoint: process.env.MLCOMMONS_ENDPOINT || '',
  accuracyThreshold: parseFloat(process.env.ACCURACY_THRESHOLD || '85'),
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  maxQuestions: parseInt(process.env.MAX_QUESTIONS || '0'), // 0 = all
};

// Validate required config
if (!CONFIG.oasisEndpoint) {
  console.error('❌ Error: MLCOMMONS_ENDPOINT is required');
  console.error('Set it in your .env file or export it as an environment variable');
  process.exit(1);
}

// ============================================================================
// Agent Service Integration
// ============================================================================

async function callOasisAgent(query: string): Promise<{ response: string; latencyMs: number }> {
  const startTime = Date.now();
  
  // Import agent service dynamically
  const { signAgentRequest } = await import('../server/services/auth/sigv4Signer.js');
  
  // Prepare payload
  const payload = {
    parameters: {
      question: query,
    },
  };

  // Get SigV4 headers for OASIS
  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };

  if (CONFIG.oasisEndpoint.includes('oasis') && CONFIG.oasisEndpoint.includes('amazonaws.com')) {
    const sigv4Headers = await signAgentRequest(CONFIG.oasisEndpoint, payload);
    headers = { ...headers, ...sigv4Headers };
  }

  // Call agent
  const response = await fetch(CONFIG.oasisEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agent error: ${response.status} - ${errorText}`);
  }

  // Parse SSE stream to extract response text
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let fullResponse = '';
  let currentMessage = '';

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
            
            // OASIS format: data.inference_results[0].output[2].dataAsMap.content contains AG-UI event
            if (data.inference_results?.[0]?.output) {
              const outputs = data.inference_results[0].output;
              const responseOutput = outputs.find((o: any) => o.name === 'response');
              
              if (responseOutput?.dataAsMap?.content) {
                const aguiEvent = JSON.parse(responseOutput.dataAsMap.content);
                
                // Collect text content from AG-UI events
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

  // Add any remaining message
  if (currentMessage) {
    fullResponse += currentMessage;
  }

  const latencyMs = Date.now() - startTime;

  return {
    response: fullResponse.trim() || 'No response received',
    latencyMs,
  };
}

// ============================================================================
// Bedrock Judge
// ============================================================================

async function evaluateWithBedrock(
  query: string,
  expected: string,
  actual: string
): Promise<{ score: number; reasoning: string }> {
  const client = new BedrockRuntimeClient({ region: CONFIG.awsRegion });

  const prompt = `You are an expert evaluator. Compare the agent's response to the expected answer.

Query: ${query}

Expected Answer: ${expected}

Actual Response: ${actual}

Rate the accuracy of the actual response on a scale of 0-100, where:
- 100 = Perfect match, fully correct
- 80-99 = Mostly correct with minor issues
- 60-79 = Partially correct
- 40-59 = Somewhat relevant but incorrect
- 0-39 = Completely wrong or irrelevant

Respond in JSON format:
{
  "score": <number 0-100>,
  "reasoning": "<brief explanation>"
}`;

  const command = new InvokeModelCommand({
    modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const content = responseBody.content[0].text;

  // Parse JSON from response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse judge response');
  }

  const result = JSON.parse(jsonMatch[0]);
  return {
    score: result.score,
    reasoning: result.reasoning,
  };
}

// ============================================================================
// Main Benchmark Logic
// ============================================================================

async function loadDataset(): Promise<MTBenchQuestion[]> {
  // When bundled, we're in scripts/dist/, so go up two levels to project root
  const projectRoot = path.resolve(__dirname, '..');
  const datasetPath = path.resolve(projectRoot, CONFIG.datasetPath);
  
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Dataset not found at ${datasetPath}`);
  }

  const data = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  return Array.isArray(data) ? data : data.questions || [];
}

async function runBenchmark(): Promise<BenchmarkSummary> {
  console.log('🚀 Starting MT-Bench Evaluation...\n');
  console.log(`Dataset: ${CONFIG.datasetPath}`);
  console.log(`Endpoint: ${CONFIG.oasisEndpoint}`);
  console.log(`Threshold: ${CONFIG.accuracyThreshold}%\n`);

  // Load dataset
  let questions = await loadDataset();
  
  if (CONFIG.maxQuestions > 0) {
    questions = questions.slice(0, CONFIG.maxQuestions);
  }

  console.log(`Loaded ${questions.length} questions\n`);

  // Run evaluations
  const results: BenchmarkResult[] = [];

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const query = question.turns[0]; // Use first turn only
    const expected = question.reference || 'No reference provided';

    console.log(`[${i + 1}/${questions.length}] Evaluating: ${question.category}`);
    console.log(`  Query: ${query.substring(0, 80)}...`);

    try {
      // Call agent
      const { response: actual, latencyMs } = await callOasisAgent(query);

      // Evaluate with judge
      const { score, reasoning } = await evaluateWithBedrock(query, expected, actual);

      results.push({
        questionId: question.question_id,
        category: question.category,
        query,
        expected,
        actual,
        accuracyScore: score,
        reasoning,
        latencyMs,
      });

      console.log(`  ✓ Score: ${score}/100 (${latencyMs}ms)`);
      console.log(`  Reasoning: ${reasoning}\n`);
    } catch (error) {
      console.error(`  ✗ Error: ${error}\n`);
      results.push({
        questionId: question.question_id,
        category: question.category,
        query,
        expected,
        actual: 'ERROR',
        accuracyScore: 0,
        reasoning: `Error: ${error}`,
        latencyMs: 0,
      });
    }
  }

  // Calculate summary
  const summary = calculateSummary(results);
  return summary;
}

function calculateSummary(results: BenchmarkResult[]): BenchmarkSummary {
  const totalQuestions = results.length;
  const averageAccuracy = results.reduce((sum, r) => sum + r.accuracyScore, 0) / totalQuestions;
  const passRate = (results.filter(r => r.accuracyScore >= CONFIG.accuracyThreshold).length / totalQuestions) * 100;

  // By category
  const byCategory: Record<string, { accuracy: number; count: number }> = {};
  
  results.forEach(result => {
    if (!byCategory[result.category]) {
      byCategory[result.category] = { accuracy: 0, count: 0 };
    }
    byCategory[result.category].accuracy += result.accuracyScore;
    byCategory[result.category].count += 1;
  });

  // Average by category
  Object.keys(byCategory).forEach(category => {
    byCategory[category].accuracy /= byCategory[category].count;
  });

  return {
    totalQuestions,
    averageAccuracy,
    passRate,
    byCategory,
    results,
  };
}

function printSummary(summary: BenchmarkSummary): void {
  console.log('\n' + '='.repeat(60));
  console.log('📊 BENCHMARK RESULTS');
  console.log('='.repeat(60) + '\n');

  console.log(`Total Questions: ${summary.totalQuestions}`);
  console.log(`Average Accuracy: ${summary.averageAccuracy.toFixed(2)}%`);
  console.log(`Pass Rate (≥${CONFIG.accuracyThreshold}%): ${summary.passRate.toFixed(2)}%\n`);

  console.log('By Category:');
  Object.entries(summary.byCategory).forEach(([category, stats]) => {
    console.log(`  ${category}: ${stats.accuracy.toFixed(2)}% (${stats.count} questions)`);
  });

  console.log('\n' + '='.repeat(60));

  // Pass/Fail
  const passed = summary.averageAccuracy >= CONFIG.accuracyThreshold;
  console.log(passed ? '✅ PASSED' : '❌ FAILED');
  console.log('='.repeat(60) + '\n');
}

function saveReport(summary: BenchmarkSummary): void {
  // When bundled, we're in scripts/dist/, so go up two levels to project root
  const projectRoot = path.resolve(__dirname, '..');
  const reportPath = path.join(projectRoot, 'benchmark-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
  console.log(`📄 Report saved to: ${reportPath}\n`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  try {
    const summary = await runBenchmark();
    printSummary(summary);
    saveReport(summary);

    // Exit with appropriate code for CI/CD
    const passed = summary.averageAccuracy >= CONFIG.accuracyThreshold;
    process.exit(passed ? 0 : 1);
  } catch (error) {
    console.error('❌ Benchmark failed:', error);
    process.exit(1);
  }
}

main();
