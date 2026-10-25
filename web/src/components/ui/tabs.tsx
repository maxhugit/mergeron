import { Tabs as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

export function Tabs(props: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root {...props} />;
}
export function TabsList(props: ComponentProps<typeof Primitive.List>) {
  return <Primitive.List {...props} />;
}
export function TabsContent(props: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content {...props} />;
}
export function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        'rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-secondary data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}
