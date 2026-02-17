/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Olly Connector
 * 
 * Specialized connector for the Olly agent (OASIS deployment of ML-Commons agent).
 * Extends BaseConnector with AG-UI streaming protocol and OASIS-specific configuration.
 * 
 * Key differences from generic ML-Commons connector:
 * - Always uses OASIS endpoint (requires OLLY_ENDPOINT env var)
 * - Always applies SigV4 authentication for OASIS
 * - Uses Olly-specific headers for data source configuration
 * - Optimized for production OASIS deployment
 */

import { BaseConnector } from '../base/BaseConnector';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from '@/services/connectors/types';
import { consumeSSEStream } from '@/services/agent/sseStream';
import { buildAgentPayload, AgentRequestPayload } from '@/services/agent/payloadBuilder';
import { AGUIToTrajectoryConverter, computeTrajectoryFromRawEvents } from '@/services/agent/aguiConverter';
import type { TrajectoryStep } from '@/types';
import type { AGUIEvent } from '@/types/agui';

export class OllyConnector extends BaseConnector {
  readonly type = 'olly' as const;
  readonly name = 'Olly (OASIS)';
  readonly supportsStreaming = true;

  /**
   * Build AG-UI payload from standard request
   */
  buildPayload(request: ConnectorRequest): AgentRequestPayload {
    return buildAgentPayload(
      request.testCase,
      request.modelId,
      request.threadId,
      request.runId
    );
  }

  /**
   * Execute request with Olly-specific handling
   * Uses AG-UI streaming protocol with SigV4 authentication for OASIS
   */
  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    // Validate that endpoint is configured
    if (!endpoint || endpoint.trim() === '') {
      throw new Error(
        'Olly endpoint not configured. Please set OLLY_ENDPOINT in your .env file.\n' +
        'Example: OLLY_ENDPOINT=https://oasis.us-west-2.opensearch-beta.amazonaws.com/_plugins/_ml/agents/{agent_id}/_execute/stream'
      );
    }

    // Validate that it's an OASIS endpoint
    if (!endpoint.includes('oasis') || !endpoint.includes('amazonaws.com')) {
      this.debug('Warning: Olly connector expects an OASIS endpoint, but got:', endpoint);
    }

    // Use pre-built payload from hook if available, otherwise build fresh
    const payload = request.payload || this.buildPayload(request);
    let headers = this.buildAuthHeaders(auth);
    
    // Always apply SigV4 authentication for OASIS endpoints
    this.debug('OASIS endpoint detected, applying SigV4 authentication');
    try {
      // Dynamic import to avoid bundling in browser
      const { signAgentRequest } = await import('../../../server/services/auth/sigv4Signer.js');
      const sigv4Headers = await signAgentRequest(endpoint, payload);
      headers = { ...headers, ...sigv4Headers };
      this.debug('SigV4 headers applied successfully');
    } catch (error) {
      this.debug('SigV4 signing failed:', error);
      throw new Error(`SigV4 authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    const trajectory: TrajectoryStep[] = [];
    const rawEvents: AGUIEvent[] = [];
    const converter = new AGUIToTrajectoryConverter();

    this.debug('Executing Olly streaming request');

    await consumeSSEStream(
      endpoint,
      payload,
      (event: AGUIEvent) => {
        // Capture raw event for debugging
        rawEvents.push(event);
        onRawEvent?.(event);

        // Convert to trajectory steps
        const steps = converter.processEvent(event);
        steps.forEach(step => {
          trajectory.push(step);
          onProgress?.(step);
        });
      },
      headers
    );

    const runId = converter.getRunId();
    this.debug('Stream completed. RunId:', runId, 'Steps:', trajectory.length);

    return {
      trajectory,
      runId,
      rawEvents,
      metadata: {
        threadId: converter.getThreadId(),
      },
    };
  }

  /**
   * Parse raw AG-UI events into trajectory steps
   * Used for re-processing stored raw events
   */
  parseResponse(rawEvents: AGUIEvent[]): TrajectoryStep[] {
    return computeTrajectoryFromRawEvents(rawEvents);
  }
}
