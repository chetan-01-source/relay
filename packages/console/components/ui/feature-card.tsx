import * as React from 'react';
import { cn } from '../../app/lib/utils';
import { Card } from './card';

/**
 * The console's signature card motif (Enterprise Gateway design system — docs/UI-THEME.md): a
 * square-cornered surface with primary-colored corner brackets. Use it to frame a section or an
 * emphasis panel; keep plain <Card> for dense data tables. Adapted from the tailark reference.
 */
export function FeatureCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('group relative rounded-none shadow-zinc-950/5', className)}>
      <CardDecorator />
      {children}
    </Card>
  );
}

/** The four primary corner brackets that give the FeatureCard its technical, blueprint feel. */
export function CardDecorator() {
  return (
    <>
      <span className="absolute -left-px -top-px block size-2 border-l-2 border-t-2 border-primary" />
      <span className="absolute -right-px -top-px block size-2 border-r-2 border-t-2 border-primary" />
      <span className="absolute -bottom-px -left-px block size-2 border-b-2 border-l-2 border-primary" />
      <span className="absolute -bottom-px -right-px block size-2 border-b-2 border-r-2 border-primary" />
    </>
  );
}
