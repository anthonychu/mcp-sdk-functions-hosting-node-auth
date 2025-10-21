import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { ManagedIdentityCredential, OnBehalfOfCredential } from '@azure/identity';

// Create an MCP server
const server = new McpServer({
    name: 'demo-server',
    version: '1.0.0'
});

// Add an addition tool
server.registerTool(
    'add',
    {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
        outputSchema: { result: z.number() }
    },
    async ({ a, b }) => {
        const output = { result: a + b };
        return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output
        };
    }
);

// Add Get Current User tool using On-Behalf-Of flow with Azure App Service authentication
server.registerTool(
    'get_current_user',
    {
        title: 'Get Current User',
        description: 'Get current logged-in user information from Microsoft Graph using Azure App Service authentication headers and On-Behalf-Of flow',
        inputSchema: {},
        outputSchema: {
            authenticated: z.boolean(),
            user: z.object({}).optional(),
            message: z.string().optional()
        }
    },
    async (_, extra) => {
        const headers = extra?.requestInfo?.headers;

        if (!headers) {
            const output = { authenticated: false, message: 'No authentication headers found' };
            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structuredContent: output
            };
        }

        // the client principal info can also be accessed in these headers
        // const clientPrincipalHeader = headers['x-ms-client-principal'];
        // const clientPrincipalId = headers['x-ms-client-principal-id'];
        // const clientPrincipalName = headers['x-ms-client-principal-name'];
        // const clientPrincipalIdp = headers['x-ms-client-principal-idp'];

        try {
            // get the auth token from Authorization header and remove the "Bearer " prefix
            const authToken = (headers['authorization'] as string).split(' ')[1];

            const tokenExchangeAudience = process.env.TokenExchangeAudience ?? "api://AzureADTokenExchange";
            const publicTokenExchangeScope = `${tokenExchangeAudience}/.default`;
            const federatedCredentialClientId = process.env.OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID;
            const clientId = process.env.WEBSITE_AUTH_CLIENT_ID;

            const managedIdentityCredential = new ManagedIdentityCredential(federatedCredentialClientId!);

            const oboCredential = new OnBehalfOfCredential({
                tenantId: process.env.WEBSITE_AUTH_AAD_ALLOWED_TENANTS!,
                clientId: clientId!,
                userAssertionToken: authToken!,
                getAssertion: async () => (await managedIdentityCredential.getToken(publicTokenExchangeScope)).token
            });

            // Call Microsoft Graph API to get user information
            const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
                headers: {
                    'Authorization': `Bearer ${(await oboCredential.getToken('https://graph.microsoft.com/.default'))?.token}`
                }
            });
            const graphData = await graphResponse.json();
            const output = { authenticated: true, user: graphData, message: 'Successfully retrieved user information from Microsoft Graph' };
            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structuredContent: output
            };

        } catch (error) {
            console.error('Error during token exchange and Graph API call:', error);
            const errorOutput = {
                authenticated: false,
                message: `Error during token exchange and Graph API call. You're logged in but might need to grant consent to the application. Open a browser to the following link to consent: https://${process.env.WEBSITE_HOSTNAME}/.auth/login/aad`
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
                structuredContent: errorOutput
            };
        }
    }
);

// Set up Express and HTTP transport
const app = express();
app.use(express.json());

app.post('/mcp', async (req: Request, res: Response) => {
    // Create a new transport for each request to prevent request ID collisions
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
    });

    res.on('close', () => {
        transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

const port = parseInt(process.env.FUNCTIONS_CUSTOMHANDLER_PORT || '3000');
app.listen(port, () => {
    console.log(`Demo MCP Server running on http://localhost:${port}/mcp`);
}).on('error', (error: Error) => {
    console.error('Server error:', error);
    process.exit(1);
});
