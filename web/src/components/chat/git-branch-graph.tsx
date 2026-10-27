import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { gitGet, type GitGraph } from '@/lib/workspace-git-api';

/** Stable lanes follow first parents; merge parents open additional lanes. */
// eslint-disable-next-line react-refresh/only-export-components -- Pure layout is exported for deterministic graph regression tests.
export function graphLayout(items: GitGraph['items']) {
  const lanes: Array<string | null> = [];
  let width = 1;
  const rows = items.map((item) => {
    let lane = lanes.indexOf(item.sha);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = item.sha;
    }
    lanes[lane] = null;
    item.parents.forEach((parent, index) => {
      if (lanes.includes(parent)) return;
      let slot =
        index === 0 && lanes[lane] === null ? lane : lanes.indexOf(null);
      if (slot < 0) slot = lanes.length;
      lanes[slot] = parent;
    });
    width = Math.max(width, lanes.length, lane + 1);
    return { item, lane };
  });
  return { rows, width };
}

export function GitBranchGraph({
  projectId,
  copyId,
  resourceId,
  active: visible = true,
}: {
  projectId: string;
  copyId?: string;
  resourceId?: string;
  active?: boolean;
}) {
  const { t, i18n } = useTranslation('workspaces');
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({
    queryKey: [
      'workspace-git-graph',
      projectId,
      copyId ?? resourceId,
      copyId ? 'local' : 'remote',
    ],
    queryFn: ({ signal }) =>
      gitGet<GitGraph>(
        projectId,
        copyId
          ? `copies/${encodeURIComponent(copyId)}/graph`
          : `connections/${encodeURIComponent(resourceId!)}/graph`,
        signal,
      ),
    retry: false,
    enabled: visible && Boolean(copyId || resourceId),
  });
  const { rows, width } = graphLayout(query.data?.items ?? []);
  const active = rows.find((r) => r.item.sha === selected)?.item;
  const colors = [
    'var(--primary)',
    '#38bdf8',
    '#34d399',
    '#fbbf24',
    '#f472b6',
    '#a78bfa',
  ];
  const x = (lane: number) => 12 + lane * 18;
  const y = (row: number) => 28 + row * 64;
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{t('gitGraphTitle')}</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('gitRefresh')}
        </Button>
      </div>
      <p className="text-muted-foreground">
        {t(copyId ? 'gitGraphHelp' : 'gitRemoteGraphHelp')}
      </p>
      {query.isPending ? (
        <p role="status">{t('gitLoading')}</p>
      ) : query.isError ? (
        <p role="alert">{t('gitInspectionError')}</p>
      ) : (
        <>
          {!rows.length && <p>{t('gitNoCommit')}</p>}
          <div
            className="max-h-[520px] overflow-auto rounded border"
            aria-label={t('gitGraphTitle')}
          >
            <div
              className="relative grid"
              style={{
                gridTemplateColumns: `${Math.max(40, width * 18 + 16)}px minmax(160px, 1fr)`,
              }}
            >
              <svg
                aria-hidden="true"
                width={Math.max(40, width * 18 + 16)}
                height={rows.length * 64}
              >
                {rows.flatMap((row, index) =>
                  row.item.parents.map((parent) => {
                    const target = rows.findIndex((r) => r.item.sha === parent);
                    if (target < 0)
                      return (
                        <path
                          key={`${row.item.sha}-${parent}`}
                          d={`M ${x(row.lane)} ${y(index)} v 25`}
                          stroke={colors[row.lane % colors.length]}
                          strokeDasharray="3 3"
                          fill="none"
                        />
                      );
                    return (
                      <path
                        key={`${row.item.sha}-${parent}`}
                        d={`M ${x(row.lane)} ${y(index)} C ${x(row.lane)} ${y(index) + 24}, ${x(rows[target].lane)} ${y(target) - 24}, ${x(rows[target].lane)} ${y(target)}`}
                        stroke={colors[row.lane % colors.length]}
                        strokeWidth="2"
                        fill="none"
                      />
                    );
                  }),
                )}
                {rows.map((row, index) => (
                  <circle
                    key={row.item.sha}
                    cx={x(row.lane)}
                    cy={y(index)}
                    r={row.item.current ? 5 : 4}
                    fill={colors[row.lane % colors.length]}
                    stroke="var(--background)"
                    strokeWidth="2"
                  />
                ))}
              </svg>
              <ol>
                {rows.map(({ item }) => (
                  <li key={item.sha} className="h-16 border-b last:border-0">
                    <button
                      type="button"
                      aria-pressed={selected === item.sha}
                      className="h-full w-full min-w-0 space-y-1 px-2 text-left hover:bg-muted aria-pressed:bg-muted"
                      onClick={() => setSelected(item.sha)}
                      title={item.subject}
                    >
                      <span className="flex gap-1 overflow-hidden">
                        {item.current && (
                          <span className="rounded bg-primary/15 px-1 text-primary">
                            HEAD
                          </span>
                        )}
                        {item.refs.map((ref) => (
                          <span
                            key={`${ref.remote}:${ref.name}`}
                            className="truncate rounded bg-muted px-1"
                            title={ref.name}
                          >
                            {ref.remote ? '☁ ' : ''}
                            {ref.name}
                          </span>
                        ))}
                      </span>
                      <span className="block truncate">{item.subject}</span>
                      <span className="block truncate text-muted-foreground">
                        {item.sha.slice(0, 7)} · {item.author}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          {query.data.limited && <p>{t('gitGraphLimited')}</p>}
          {active && (
            <section
              aria-label={t('gitGraphDetails')}
              className="space-y-1 rounded border p-2"
            >
              <h4 className="font-medium">{active.subject}</h4>
              <p className="break-all font-mono">{active.sha}</p>
              <p>
                {active.author} ·{' '}
                {new Date(active.date).toLocaleString(i18n.language)}
              </p>
              <p className="break-all">
                {t('gitGraphParents')}:{' '}
                {active.parents.map((p) => p.slice(0, 7)).join(', ') || '—'}
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
