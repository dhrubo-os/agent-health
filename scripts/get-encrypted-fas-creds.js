#!/usr/bin/env node
/**
 * Automated ENCRYPTED_FAS_CREDS Generator
 * 
 * This script automates the process of getting ENCRYPTED_FAS_CREDS for OASIS authentication.
 * It performs the same steps as neo_jwt_token.js but automatically extracts and outputs
 * the encrypted-fas-creds value ready to paste into .env file.
 * 
 * Usage:
 *   node scripts/get-encrypted-fas-creds.js
 * 
 * Output:
 *   ENCRYPTED_FAS_CREDS=AgV4UD9C/ttvxB20FRkknJCO4gEnuQpmHHy1KCQ2l11nE4sAoQADABVhd3MtY3J5cHRvLXB1Ymxp...
 */

import { execSync } from 'child_process';
import AWS from 'aws-sdk';
import axios from 'axios';

const DEFAULT_CONFIG = {
    endpoint: 'https://application-olly3-pre-release-integration-zz1jwht80jvvdq2b8otc.us-west-2.opensearch-beta.amazonaws.com',
    region: 'us-west-2',
    stage: 'beta',
    neoAccountId: '631352388807',
    beholderAccountId: '766561701029',
    neoRole: 'Admin'
};

const config = {
    endpoint: '',
    region: '',
    stage: '',
    neoAccountId: '',
    beholderAccountId: '',
    neoRole: ''
};

const runCommand = (command) => {
    return execSync(command, { stdio: 'inherit' });
};

const getTemporaryCredentialsForAccount = (accountId, role, profile) => {
    const authCommand = 'if ! mwinit -l; then mwinit -o; fi';
    const credentialCommand = `ada credentials update --account=${accountId} --provider=isengard --role=${role} --profile=${profile} --once`;
    
    runCommand(authCommand);
    runCommand(credentialCommand);
    
    return new AWS.SharedIniFileCredentials({ profile });
};

async function signRequest(request, credentials) {
    return new Promise((resolve, reject) => {
        const endpoint = new AWS.Endpoint(request.hostname);
        const req = new AWS.HttpRequest(endpoint, config.region);

        req.method = request.method;
        req.path = request.path;
        req.headers = request.headers;
        req.body = request.body || '';

        const signer = new AWS.Signers.V4(req, 'opensearch');
        signer.addAuthorization(credentials, new Date());

        resolve(req);
    });
}

async function makeNeoRequest(credentials) {
    try {
        const endpoint = new URL(config.endpoint);
        
        const request = {
            method: 'GET',
            hostname: endpoint.hostname,
            path: '/userinfo',
            headers: {
                'Host': endpoint.hostname,
                'Content-Type': 'application/json',
                'osd-xsrf': 'osd-fetch'
            },
            body: ''
        };

        const signedRequest = await signRequest(request, credentials);

        const response = await axios({
            method: 'GET',
            url: `${config.endpoint}/userinfo`,
            headers: signedRequest.headers,
            validateStatus: null
        });

        if (response.status !== 200) {
            throw new Error(`Request failed with status ${response.status}`);
        }

        const requestId = response.headers['x-request-id'];
        if (!requestId) {
            throw new Error('No x-request-id found in response headers');
        }

        return requestId;
    } catch (error) {
        console.error('Error making Neo request:', error);
        throw error;
    }
}

async function getJwtTokenFromCloudWatch(requestId, credentials) {
    try {
        const cloudwatchlogs = new AWS.CloudWatchLogs({
            credentials: credentials,
            region: config.region
        });

        const endTime = new Date().getTime();
        const startTime = endTime - (5 * 60 * 1000);

        const params = {
            logGroupName: `ServiceGateway-SecurityAgent-${config.region}-${config.stage}`,
            startTime: startTime,
            endTime: endTime,
            filterPattern: `"X-Amz-Juno-Sectoken" "${requestId}"`,
            limit: 50
        };

        console.log('Searching logs...');

        const logs = await cloudwatchlogs.filterLogEvents(params).promise();
        
        if (!logs.events || logs.events.length === 0) {
            return null;
        }

        for (const event of logs.events) {
            const message = event.message;
            const match = message.match(/X-Amz-Juno-Sectoken:\[Bearer ([^\]]+)\]/);
            if (match && match[1]) {
                return match[1];
            }
        }

        return null;
    } catch (error) {
        console.error('Error getting token from CloudWatch:', error);
        throw error;
    }
}

async function waitForToken(requestId, beholderCredentials, maxAttempts = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`Attempting to find token (attempt ${attempt}/${maxAttempts})...`);
        
        const token = await getJwtTokenFromCloudWatch(requestId, beholderCredentials);
        if (token) {
            return token;
        }

        if (attempt < maxAttempts) {
            console.log(`Token not found, waiting ${delayMs/1000} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    throw new Error('Failed to find token after maximum attempts');
}

/**
 * Decode JWT and extract encrypted-fas-creds
 * Note: CloudWatch truncates the JWT, but we only need the payload (2nd part)
 */
function extractEncryptedFasCreds(jwtToken) {
    try {
        // JWT format: header.payload.signature (but signature may be truncated)
        const parts = jwtToken.split('.');
        
        if (parts.length < 2) {
            throw new Error('Invalid JWT format - need at least header and payload');
        }

        // Decode the payload (base64url) - this is the 2nd part
        const payload = parts[1];
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = Buffer.from(base64, 'base64').toString('utf8');
        const decoded = JSON.parse(jsonPayload);

        // Extract encrypted-fas-creds
        const encryptedFasCreds = decoded['encrypted-fas-creds'];
        if (!encryptedFasCreds) {
            throw new Error('encrypted-fas-creds not found in JWT payload');
        }

        return encryptedFasCreds;
    } catch (error) {
        console.error('Error decoding JWT:', error);
        throw error;
    }
}

async function main() {
    try {
        // Load configuration with defaults and environment variables
        config.endpoint = process.env.NEO_ENDPOINT || DEFAULT_CONFIG.endpoint;
        config.region = process.env.REGION || process.env.AWS_REGION || DEFAULT_CONFIG.region;
        config.stage = process.env.STAGE || DEFAULT_CONFIG.stage;
        config.neoAccountId = process.env.NEO_ACCOUNT_ID || DEFAULT_CONFIG.neoAccountId;
        config.beholderAccountId = process.env.BEHOLDER_ACCOUNT_ID || DEFAULT_CONFIG.beholderAccountId;
        config.neoRole = process.env.NEO_ROLE || DEFAULT_CONFIG.neoRole;

        console.log('\n=== ENCRYPTED_FAS_CREDS Generator ===');
        console.log(`Endpoint: ${config.endpoint}`);
        console.log(`Region: ${config.region}\n`);

        console.log('Step 1: Getting Neo account credentials...');
        const neoCredentials = getTemporaryCredentialsForAccount(
            config.neoAccountId,
            config.neoRole,
            'neo_profile'
        );
        
        console.log('Step 2: Getting beholder account credentials...');
        const beholderCredentials = getTemporaryCredentialsForAccount(
            config.beholderAccountId,
            'ReadOnly',
            'beholder_profile'
        );

        console.log('Step 3: Making Neo request...');
        const requestId = await makeNeoRequest(neoCredentials);
        console.log('Request ID:', requestId);

        console.log('Step 4: Waiting for JWT token in CloudWatch logs...');
        const token = await waitForToken(requestId, beholderCredentials);
        
        console.log('Step 5: Extracting encrypted-fas-creds from JWT...');
        const encryptedFasCreds = extractEncryptedFasCreds(token);
        
        console.log('\n=== SUCCESS ===\n');
        console.log('Copy this line to your .env file:\n');
        console.log(`ENCRYPTED_FAS_CREDS=${encryptedFasCreds}\n`);
        
    } catch (error) {
        console.error('\n=== ERROR ===');
        console.error(error.message);
        process.exit(1);
    }
}

main();
