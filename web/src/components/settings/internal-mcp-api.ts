import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export interface McpJsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, McpJsonSchema>;
  required?: string[];
  anyOf?: McpJsonSchema[];
  [key: string]: unknown;
}
export interface InternalMcpCatalog {
  server: {
    name: string;
    version: string;
    transport: string;
    exposure: string;
    authentication: string;
  };
  instructions: string;
  protocolMethods: string[];
  limits: Record<string, number>;
  errors: string[];
  tools: Array<{
    name: string;
    title: string;
    titleFr?: string;
    aliases?: string[];
    description: string;
    descriptionFr: string;
    readOnly: boolean;
    inputSchema: McpJsonSchema;
    outputSchema: McpJsonSchema;
    example: Record<string, unknown>;
  }>;
}
export async function getInternalMcpCatalog(): Promise<InternalMcpCatalog> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath('/api/internal-mcp/catalog'), {
    headers: authorization ? { Authorization: authorization } : {},
  });
  if (!response.ok) throw new Error('Cannot load internal MCP catalog');
  return response.json() as Promise<InternalMcpCatalog>;
}
