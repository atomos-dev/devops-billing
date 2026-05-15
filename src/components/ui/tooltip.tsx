/**
 * Tooltip UI wrapper built on Base UI primitives.
 * Provides a lightweight shadcn-style API for hover/focus descriptions.
 */
"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@/lib/utils";

function TooltipProvider({
  delay = 150,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider> & {
  delay?: number;
}) {
  return (
    <TooltipPrimitive.Provider delay={delay} {...props} />
  );
}

function Tooltip({
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>;
}

function TooltipTrigger({
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger {...props}>
      {children}
    </TooltipPrimitive.Trigger>
  );
}

function TooltipContent({
  className,
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> & {
  sideOffset?: number;
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          className={cn(
            "z-50 max-w-sm rounded-md bg-slate-950 px-3 py-2 text-xs leading-relaxed text-slate-50 shadow-lg",
            "data-[ending-style]:animate-out data-[starting-style]:animate-in",
            "data-[ending-style]:fade-out-0 data-[starting-style]:fade-in-0",
            className
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
