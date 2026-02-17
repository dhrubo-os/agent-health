/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SigV4 Signer for OASIS Agent Endpoints
 * Ported from RegionalOasisTypeScriptRestClient
 * 
 * Automatically generates fresh FAS credentials on each request
 */

import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { execSync } from 'child_process';
import AWS from 'aws-sdk';
import axios from 'axios';

const DEFAULT_ENCRYPTED_FAS_CREDS = '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';

interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/**
 * Generate fresh FAS credentials by making a signed request to Neo endpoint
 * and extracting encrypted-fas-creds from the JWT token in CloudWatch logs
 */
async function generateFreshFasCreds(
  neoEndpoint: string,
  neoAccountId: string,
  neoRole: string,
  beholderAccountId: string,
  region: string,
  stage: string
): Promise<string> {
  console.log('\n========== GENERATING FRESH FAS CREDENTIALS ==========');
  console.log(`[FAS] Using standalone script for credential generation...`);

  try {
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // Script is at project root: /Volumes/workplace/agent-health/scripts/
    // This file is at: /Volumes/workplace/agent-health/server/services/auth/
    const scriptPath = join(__dirname, '../../../scripts/get-encrypted-fas-creds.js');
    
    const output = execSync(`node "${scriptPath}"`, {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEO_ENDPOINT: neoEndpoint,
        REGION: region,
        STAGE: stage,
        NEO_ACCOUNT_ID: neoAccountId,
        BEHOLDER_ACCOUNT_ID: beholderAccountId,
        NEO_ROLE: neoRole
      },
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    // Extract ENCRYPTED_FAS_CREDS from output
    const match = output.match(/ENCRYPTED_FAS_CREDS=(.+)/);
    if (!match || !match[1]) {
      throw new Error('Could not extract ENCRYPTED_FAS_CREDS from script output');
    }

    const encryptedFasCreds = match[1].trim();
    console.log(`[FAS] ✓ Generated fresh credentials (${encryptedFasCreds.length} chars)`);
    console.log('========================================\n');
    return encryptedFasCreds;
  } catch (error: any) {
    console.error('[FAS] Script execution failed:', error.message);
    throw error;
  }
}

/**
 * Get AWS credentials by running ada + assuming role
 */
async function getAwsCredentialsFromAssumedRole(
  accountId: string,
  roleArn: string,
  region: string
): Promise<AWSCredentials> {
  
  console.log('\n========== AWS CREDENTIALS ACQUISITION ==========');
  console.log(`[SigV4] Account ID: ${accountId}`);
  console.log(`[SigV4] Role ARN: ${roleArn}`);
  console.log(`[SigV4] Region: ${region}`);
  
  try {
    console.log('[SigV4] Running ada credentials update...');
    execSync(
      `ada credentials update --role=Admin --provider=isengard --once --account=${accountId}`, 
      { stdio: 'inherit' }
    );
    console.log('[SigV4] ✓ Ada credentials updated successfully!');
  } catch (error) {
    console.error('[SigV4] ✗ Failed to update credentials via ada:', error);
    throw error;
  }

  console.log(`[SigV4] Assuming role via STS...`);
  console.log(`[SigV4] Role: ${roleArn}`);

  const stsClient = new STSClient({ region });
  
  const assumeRoleCommand = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'dashboards-traces-backend',
    DurationSeconds: 3600
  });

  try {
    const assumeRoleResponse = await stsClient.send(assumeRoleCommand);

    if (!assumeRoleResponse.Credentials) {
      throw new Error('No credentials returned from assume role operation');
    }

    const credentials = assumeRoleResponse.Credentials;
    console.log('[SigV4] ✓ Successfully assumed role!');
    console.log(`[SigV4] Access Key ID: ${credentials.AccessKeyId?.substring(0, 20)}...`);
    console.log(`[SigV4] Session Token (first 30 chars): ${credentials.SessionToken?.substring(0, 30)}...`);
    console.log(`[SigV4] Expiration: ${credentials.Expiration}`);
    console.log(`[SigV4] Time until expiration: ${Math.floor((new Date(credentials.Expiration!).getTime() - Date.now()) / 60000)} minutes`);

    return {
      accessKeyId: credentials.AccessKeyId!,
      secretAccessKey: credentials.SecretAccessKey!,
      sessionToken: credentials.SessionToken!
    };
  } catch (error) {
    console.error('[SigV4] ✗ Failed to assume role:', error);
    throw error;
  }
}

/**
 * Sign OASIS agent request with SigV4
 * Returns headers to be added to the request
 */
export async function signAgentRequest(
  endpoint: string,
  payload: any
): Promise<Record<string, string>> {
  
  console.log('\n========== SIGV4 SIGNING REQUEST ==========');
  console.log(`[SigV4] Endpoint: ${endpoint}`);
  console.log(`[SigV4] Payload size: ${JSON.stringify(payload).length} bytes`);
  
  // Read config from environment
  const accountId = process.env.SIGV4_ACCOUNT_ID || '631352388807';
  const roleArn = process.env.SIGV4_ROLE_ARN || 'arn:aws:iam::631352388807:role/Devstack-AOSDEcsService-b-AOSDEcsTaskInstanceRole51-MQ8gNx23OjoC';
  const region = process.env.SIGV4_REGION || 'us-west-2';
  const applicationId = process.env.SIGV4_APPLICATION_ID || 'zz1jwht80jvvdq2b8otc';
  const fasKmsKeyArn = process.env.SIGV4_FAS_KMS_KEY_ARN || 'arn:aws:kms:us-west-2:640632644840:key/f40d283f-95de-4185-980c-a641340b14f1';
  
  // FAS credential generation config
  const neoEndpoint = process.env.NEO_ENDPOINT || 'https://application-olly3-pre-release-integration-zz1jwht80jvvdq2b8otc.us-west-2.opensearch-beta.amazonaws.com';
  const neoAccountId = process.env.NEO_ACCOUNT_ID || accountId;
  const neoRole = process.env.NEO_ROLE || 'Admin';
  const beholderAccountId = process.env.BEHOLDER_ACCOUNT_ID || '766561701029';
  const stage = process.env.STAGE || 'beta';
  
  console.log('[SigV4] Configuration:');
  console.log(`  - Account ID: ${accountId}`);
  console.log(`  - Application ID: ${applicationId}`);
  console.log(`  - Region: ${region}`);
  console.log(`  - FAS KMS Key: ${fasKmsKeyArn}`);
  
  const urlObj = new URL(endpoint);
  const host = urlObj.hostname;
  console.log(`[SigV4] Host: ${host}`);

  // Generate fresh FAS credentials
  let encryptedFasCreds: string;
  try {
    encryptedFasCreds = await generateFreshFasCreds(
      neoEndpoint,
      neoAccountId,
      neoRole,
      beholderAccountId,
      region,
      stage
    );
  } catch (error) {
    console.warn('[SigV4] Failed to generate fresh FAS credentials, using default:', error);
    encryptedFasCreds = process.env.ENCRYPTED_FAS_CREDS || DEFAULT_ENCRYPTED_FAS_CREDS;
    console.log(`[SigV4] Using fallback credentials (${encryptedFasCreds.length} chars)`);
  }

  // Step 1: Get credentials via ada + assume role
  const credentials = await getAwsCredentialsFromAssumedRole(accountId, roleArn, region);
  
  // Step 2: Sign auth endpoint request
  console.log('\n[SigV4] Step 2: Signing auth endpoint request...');
  const authRequest = new HttpRequest({
    method: 'POST',
    hostname: host,
    path: '/auth/get-token-for-oasis-regional-internal',
    headers: {
      'Content-Type': 'application/json',
      'x-amzn-service-account': accountId,
      'x-amzn-aosd-application-id': applicationId,
      'host': host
    }
  });

  console.log('[SigV4] Auth request details:');
  console.log(`  - Method: ${authRequest.method}`);
  console.log(`  - Hostname: ${authRequest.hostname}`);
  console.log(`  - Path: ${authRequest.path}`);

  const signer = new SignatureV4({
    credentials,
    region,
    service: 'oasis',
    sha256: Sha256,
    applyChecksum: false
  });

  console.log('[SigV4] Signing with SignatureV4...');
  const signedRequest = await signer.sign(authRequest);
  console.log('[SigV4] ✓ Request signed successfully');

  // Step 3: Build headers for agent execution
  console.log('\n[SigV4] Step 3: Building headers for agent execution...');
  
  // Get datasource endpoint from environment
  const datasourceEndpoint = process.env.MLCOMMONS_HEADER_OPENSEARCH_URL || '';
  const datasourceRegion = process.env.MLCOMMONS_HEADER_AWS_REGION || '';
  const datasourceAccessKey = process.env.MLCOMMONS_HEADER_AWS_ACCESS_KEY_ID || '';
  const datasourceSecretKey = process.env.MLCOMMONS_HEADER_AWS_SECRET_ACCESS_KEY || '';
  const datasourceSessionToken = process.env.MLCOMMONS_HEADER_AWS_SESSION_TOKEN || '';
  
  console.log(`[SigV4] Datasource endpoint: ${datasourceEndpoint}`);
  console.log(`[SigV4] Datasource region: ${datasourceRegion}`);
  console.log(`[SigV4] Datasource credentials: ${datasourceAccessKey ? 'configured' : 'missing'}`);
  
  const headers: Record<string, string> = {
    'x-amzn-service-account': accountId,
    'x-amzn-aosd-application-id': applicationId,
    'x-amzn-auth-endpoint': host,
    'x-amzn-client-account': accountId,
    'X-Amz-Date': signedRequest.headers['x-amz-date'] || '',
    'Authorization': signedRequest.headers['authorization'] || '',
    'encrypted-fas-creds': encryptedFasCreds,
    'fas-kms-key-arn': fasKmsKeyArn
  };
  
  // Add datasource headers if configured
  if (datasourceEndpoint) {
    headers['x-amzn-datasource-endpoint'] = datasourceEndpoint;
    headers['x-amzn-datasource-type'] = 'es';
    
    // Add datasource AWS credentials if provided
    if (datasourceAccessKey && datasourceSecretKey) {
      headers['x-amzn-datasource-aws-region'] = datasourceRegion;
      headers['x-amzn-datasource-aws-access-key-id'] = datasourceAccessKey;
      headers['x-amzn-datasource-aws-secret-access-key'] = datasourceSecretKey;
      if (datasourceSessionToken) {
        headers['x-amzn-datasource-aws-session-token'] = datasourceSessionToken;
      }
      console.log('[SigV4] ✓ Added datasource headers with AWS credentials');
    } else {
      console.log('[SigV4] ✓ Added datasource headers (no credentials)');
    }
  } else {
    console.warn('[SigV4] ⚠ No datasource endpoint configured - agent may not be able to query data');
  }

  if (signedRequest.headers['x-amz-security-token']) {
    headers['X-Amz-Security-Token'] = signedRequest.headers['x-amz-security-token'];
    console.log(`[SigV4] ✓ Added X-Amz-Security-Token (first 30 chars): ${signedRequest.headers['x-amz-security-token'].substring(0, 30)}...`);
  } else {
    console.warn('[SigV4] ⚠ No X-Amz-Security-Token in signed request!');
  }

  console.log('[SigV4] Final headers:');
  console.log(`  - X-Amz-Date: ${headers['X-Amz-Date']}`);
  console.log(`  - Authorization (first 50 chars): ${headers['Authorization'].substring(0, 50)}...`);
  console.log(`  - X-Amz-Security-Token present: ${!!headers['X-Amz-Security-Token']}`);
  console.log('[SigV4] ✓ Request signing complete!');
  console.log('========================================\n');

  return headers;
}
