import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getInternalMcpCatalog, type McpJsonSchema } from './internal-mcp-api';

function schemaType(schema: McpJsonSchema): string {
  if (schema.anyOf) return schema.anyOf.map(schemaType).join(' | ');
  return Array.isArray(schema.type)
    ? schema.type.join(' | ')
    : (schema.type ?? 'JSON');
}
function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 max-w-full overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">
      <code>{JSON.stringify(value, null, 2)}</code>
    </pre>
  );
}

/** The server emits documentation from the same Zod schemas registered in MCP. */
export function InternalMcpSettings() {
  const { t, i18n } = useTranslation();
  const { t: mcpT } = useTranslation('internalMcp');
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['administration', 'internal-mcp-catalog'],
    queryFn: getInternalMcpCatalog,
    staleTime: 60000,
    retry: false,
  });
  if (query.isPending) return <p role="status">{t('loading')}</p>;
  if (query.isError)
    return (
      <section role="alert" className="space-y-3">
        <p>{mcpT('internalMcpLoadFailed')}</p>
        <Button
          variant="outline"
          onClick={() => {
            void query.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </section>
    );
  const catalog = query.data;
  const french = i18n.resolvedLanguage?.startsWith('fr');
  const tools = catalog.tools.filter((tool) =>
    `${tool.name} ${tool.title} ${tool.titleFr ?? ''} ${(tool.aliases ?? []).join(' ')} ${tool.description} ${tool.descriptionFr}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  return (
    <section className="min-w-0 space-y-5">
      <div className="rounded-xl border bg-card p-4 space-y-2">
        <h2 className="font-semibold">{t('internalMcpTitle')}</h2>
        <p className="text-sm text-muted-foreground">
          {mcpT('internalMcpOverview')}
        </p>
        <p className="break-words text-sm">
          <code>{catalog.server.name}</code> · {catalog.server.version} ·{' '}
          {catalog.server.transport}
        </p>
        <p className="text-sm text-muted-foreground">
          {mcpT('internalMcpSecurity')}
        </p>
        <p className="text-sm text-muted-foreground">
          {mcpT('internalMcpGenerated')}
        </p>
      </div>
      <label className="block space-y-2 text-sm">
        <span>{mcpT('internalMcpSearch')}</span>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={mcpT('internalMcpSearchPlaceholder')}
        />
      </label>
      <p className="text-sm text-muted-foreground" role="status">
        {mcpT('internalMcpCount', { count: tools.length })}
      </p>
      {tools.length === 0 && <p>{mcpT('internalMcpNoResults')}</p>}
      {tools.map((tool) => (
        <details key={tool.name} className="min-w-0 rounded-xl border bg-card">
          <summary className="cursor-pointer break-words p-4">
            <span className="font-semibold">
              {french ? (tool.titleFr ?? tool.title) : tool.title}
            </span>
            <span className="ml-3 inline-block rounded-full bg-muted px-2 py-0.5 text-xs">
              {tool.readOnly
                ? mcpT('internalMcpRead')
                : mcpT('internalMcpWrite')}
            </span>
            <code className="mt-1 block text-xs text-muted-foreground">
              {tool.name}
            </code>
          </summary>
          <div className="min-w-0 space-y-4 border-t p-4">
            {Boolean(tool.aliases?.length) && (
              <p className="break-words text-xs text-muted-foreground">
                {mcpT('internalMcpLegacyNames')}{' '}
                <code>{tool.aliases?.join(', ')}</code>
              </p>
            )}
            <p className="text-sm">
              {french ? tool.descriptionFr : tool.description}
            </p>
            <h3 className="text-sm font-semibold">
              {mcpT('internalMcpParameters')}
            </h3>
            {Object.keys(tool.inputSchema.properties ?? {}).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {mcpT('internalMcpNoParameters')}
              </p>
            ) : (
              <div className="max-w-full overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-sm">
                  <thead>
                    <tr>
                      <th className="p-2">{mcpT('internalMcpParameter')}</th>
                      <th className="p-2">{t('type')}</th>
                      <th className="p-2">{t('required')}</th>
                      <th className="p-2">{mcpT('internalMcpConstraints')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(tool.inputSchema.properties ?? {}).map(
                      ([name, schema]) => (
                        <tr key={name} className="border-t">
                          <td className="p-2 align-top">
                            <code>{name}</code>
                          </td>
                          <td className="p-2 align-top">
                            {schemaType(schema)}
                          </td>
                          <td className="p-2 align-top">
                            {t(
                              tool.inputSchema.required?.includes(name)
                                ? 'yes'
                                : 'no',
                            )}
                          </td>
                          <td className="p-2 align-top">
                            <span>{schema.description}</span>
                            <code className="block break-all text-xs">
                              {JSON.stringify(
                                Object.fromEntries(
                                  Object.entries(schema).filter(
                                    ([key]) =>
                                      !['description', 'type'].includes(key),
                                  ),
                                ),
                              )}
                            </code>
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <h3 className="text-sm font-semibold">
              {mcpT('internalMcpInputSchema')}
            </h3>
            <JsonBlock value={tool.inputSchema} />
            <h3 className="text-sm font-semibold">
              {mcpT('internalMcpOutputSchema')}
            </h3>
            <JsonBlock value={tool.outputSchema} />
            <h3 className="text-sm font-semibold">
              {mcpT('internalMcpExample')}
            </h3>
            <JsonBlock
              value={{
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: tool.name, arguments: tool.example },
              }}
            />
          </div>
        </details>
      ))}
      <details className="rounded-xl border bg-card p-4">
        <summary className="cursor-pointer font-semibold">
          {mcpT('internalMcpProtocol')}
        </summary>
        <div className="mt-4 space-y-3">
          <JsonBlock value={catalog.server} />
          <JsonBlock value={catalog.protocolMethods} />
          <h3 className="text-sm font-semibold">{mcpT('internalMcpLimits')}</h3>
          <JsonBlock value={catalog.limits} />
          <h3 className="text-sm font-semibold">{mcpT('internalMcpErrors')}</h3>
          <JsonBlock value={catalog.errors} />
          <h3 className="text-sm font-semibold">
            {mcpT('internalMcpInstructions')}
          </h3>
          <p className="break-words text-sm text-muted-foreground">
            {catalog.instructions}
          </p>
        </div>
      </details>
    </section>
  );
}
