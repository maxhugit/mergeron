import { withBasePath } from '@/base-path';

/** Decorative beside the visible application name; works behind proxy prefixes. */
export function BrandIcon({
  className = 'h-8 w-8 shrink-0',
}: {
  className?: string;
}) {
  return (
    <img
      src={withBasePath(
        document.documentElement.dataset.mergeronEnvironment === 'development'
          ? '/mergeron-dev-icon.svg'
          : '/mergeron-icon.svg',
      )}
      alt=""
      aria-hidden="true"
      className={className}
      width={32}
      height={32}
    />
  );
}
