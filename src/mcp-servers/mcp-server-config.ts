import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import type { JsonValue } from '../codex/codex-schema/serde_json/JsonValue';
import type { McpServerConfigDto } from './dto/mcp-server-config.dto';

function invalid(field: string): never {
  throw BusinessException.badRequest(
    ErrorCode.validation.fieldInvalid,
    'Invalid MCP server configuration',
    { field },
  );
}
/** Names cannot escape a table path or replace a platform-owned MCP server. */
export function validateMcpServerName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === 'constructor' ||
    value === 'prototype' ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value) ||
    /^(?:mergeron|codex|openai)(?:_|-|$)/.test(value)
  )
    invalid('name');
  return value;
}
export function mcpTransportConfig(
  body: McpServerConfigDto,
): Record<string, JsonValue> {
  if (!body || typeof body !== 'object') invalid('body');
  validateMcpServerName(body.name);
  if (body.update !== undefined && typeof body.update !== 'boolean')
    invalid('update');
  const value: Record<string, JsonValue> = {};
  if (body.transport === 'http') {
    if (typeof body.url !== 'string' || body.url.length > 2048) invalid('url');
    let url: URL;
    try {
      url = new URL(body.url);
    } catch {
      invalid('url');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      invalid('url');
    value.url = url.toString();
    if (body.command !== undefined || body.args !== undefined)
      invalid('transport');
    if (body.bearerTokenEnvVar) {
      if (
        typeof body.bearerTokenEnvVar !== 'string' ||
        !/^[A-Z_][A-Z0-9_]{0,127}$/.test(body.bearerTokenEnvVar)
      )
        invalid('bearerTokenEnvVar');
      value.bearer_token_env_var = body.bearerTokenEnvVar;
    }
  } else if (body.transport === 'stdio') {
    if (
      typeof body.command !== 'string' ||
      !body.command.trim() ||
      body.command.length > 512 ||
      /[\r\n\0]/.test(body.command)
    )
      invalid('command');
    if (body.url !== undefined || body.bearerTokenEnvVar !== undefined)
      invalid('transport');
    if (
      body.args !== undefined &&
      (!Array.isArray(body.args) ||
        body.args.length > 64 ||
        body.args.some(
          (arg) =>
            typeof arg !== 'string' ||
            arg.length > 2048 ||
            /[\r\n\0]/.test(arg),
        ))
    )
      invalid('args');
    value.command = body.command.trim();
    value.args = body.args ?? [];
  } else invalid('transport');
  return value;
}
