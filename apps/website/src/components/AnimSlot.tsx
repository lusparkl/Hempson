import { createElement, type ReactNode } from 'react';
import { ANIMATIONS, type AnimationId } from '../animations';

type Props = {
  /** Key in `ANIMATIONS`; its description says what the design pass should build here. */
  id: AnimationId;
  as?: 'div' | 'section' | 'span' | 'ul' | 'ol' | 'figure';
  className?: string;
  children?: ReactNode;
};

/**
 * Marks an element as an animation slot (`data-anim`, `data-anim-trigger`). Without children it renders an
 * empty, decorative placeholder (`data-anim-placeholder`) where an illustration or motion graphic will go.
 */
export function AnimSlot({ id, as = 'div', className, children }: Props) {
  const spec = ANIMATIONS[id];
  const empty = children === undefined;
  return createElement(
    as,
    {
      className,
      'data-anim': id,
      'data-anim-trigger': spec.trigger,
      'data-anim-placeholder': empty ? '' : undefined,
      'aria-hidden': empty ? true : undefined,
      title: empty && import.meta.env.DEV ? `${id}: ${spec.description}` : undefined,
    },
    children,
  );
}
