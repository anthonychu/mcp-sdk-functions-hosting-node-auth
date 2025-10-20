import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import { z } from 'zod';

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

// Add a tool to get current user info from Azure App Service authentication headers
server.registerTool(
    'get_current_user',
    {
        title: 'Get Current User',
        description: 'Get current logged-in user information from Azure App Service authentication headers',
        inputSchema: {},
        outputSchema: {
            authenticated: z.boolean(),
            user: z.object({
                id: z.string().optional(),
                name: z.string().optional(),
                identityProvider: z.string().optional(),
                authType: z.string().optional(),
                nameType: z.string().optional(),
                roleType: z.string().optional(),
                claims: z.array(z.object({
                    type: z.string(),
                    value: z.string()
                })).optional()
            }).optional()
        }
    },
    async (_, extra) => {
        const headers = extra?.requestInfo?.headers;
        // console.log('Request headers:', headers);
        
        if (!headers) {
            const output = { authenticated: false };
            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structuredContent: output
            };
        }

        // Convert headers to lowercase for case-insensitive lookup
        const normalizedHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            if (typeof value === 'string') {
                normalizedHeaders[key.toLowerCase()] = value;
            } else if (Array.isArray(value) && value.length > 0) {
                normalizedHeaders[key.toLowerCase()] = value[0];
            }
        }

        const clientPrincipalHeader = normalizedHeaders['x-ms-client-principal'];
        const clientPrincipalId = normalizedHeaders['x-ms-client-principal-id'];
        const clientPrincipalName = normalizedHeaders['x-ms-client-principal-name'];
        const clientPrincipalIdp = normalizedHeaders['x-ms-client-principal-idp'];

        // If no authentication headers are present, return anonymous
        if (!clientPrincipalHeader && !clientPrincipalId && !clientPrincipalName && !clientPrincipalIdp) {
            const output = { authenticated: false };
            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structuredContent: output
            };
        }

        let decodedPrincipal = null;
        if (clientPrincipalHeader) {
            try {
                // Decode the Base64-encoded JSON
                const decoded = Buffer.from(clientPrincipalHeader, 'base64').toString('utf-8');
                decodedPrincipal = JSON.parse(decoded);
            } catch (error) {
                console.error('Failed to decode client principal header:', error);
            }
        }

        const user = {
            id: clientPrincipalId || decodedPrincipal?.name_typ || undefined,
            name: clientPrincipalName || decodedPrincipal?.claims?.find((c: any) => c.typ === 'name')?.val || undefined,
            identityProvider: clientPrincipalIdp || decodedPrincipal?.auth_typ || undefined,
            authType: decodedPrincipal?.auth_typ || undefined,
            nameType: decodedPrincipal?.name_typ || undefined,
            roleType: decodedPrincipal?.role_typ || undefined,
            claims: decodedPrincipal?.claims?.map((claim: any) => ({
                type: claim.typ,
                value: claim.val
            })) || undefined
        };

        const output = { authenticated: true, user };
        return {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output
        };
    }
);



// Add a dynamic greeting resource
server.registerResource(
    'greeting',
    new ResourceTemplate('greeting://{name}', { list: undefined }),
    {
        title: 'Greeting Resource', // Display name for UI
        description: 'Dynamic greeting generator'
    },
    async (uri, { name }) => ({
        contents: [
            {
                uri: uri.href,
                text: `Hello, ${name}!`
            }
        ]
    })
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