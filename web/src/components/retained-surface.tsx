/** Withdraw portalled controls before Activity defers its hidden subtree's renders. */
import {
  Activity,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { SurfaceActivityContext } from '@/lib/surface-activity';

export function RetainedSurface({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const parentActive = useContext(SurfaceActivityContext);
  const visible = active && parentActive;
  const [wasVisible, setWasVisible] = useState(visible);
  useLayoutEffect(() => {
    // Deliberate before-paint second commit: close body portals before deferring
    // their owner's render. Skipping this leaks controls from a hidden agent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWasVisible(visible);
  }, [visible]);
  // One synchronous withdrawal render lets dialogs/menus close via context.
  // Otherwise hidden Activity skips that render and portals remain on body.
  return (
    <SurfaceActivityContext value={visible}>
      {/* Withdraw layout immediately: two sibling agents must never divide the
        available width during the closing render and remeasure each other. */}
      <div style={{ display: visible ? 'contents' : 'none' }} inert={!visible}>
        <Activity mode={visible || wasVisible ? 'visible' : 'hidden'}>
          {children}
        </Activity>
      </div>
    </SurfaceActivityContext>
  );
}
