import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export interface DialogContentProps extends Omit<ComponentProps<typeof D.Content>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  size?: "md" | "lg" | "xl";
}

export function DialogContent({ title, description, size = "md", className, children, ...props }: DialogContentProps) {
  const width = { md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-night-deep/80 backdrop-blur-sm" />
      <D.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto",
          "rounded-3xl border-2 border-line bg-panel p-6 shadow-panel animate-pop",
          width,
          className,
        )}
        {...props}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <D.Title className="title-plate text-2xl">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{title}</D.Description>
            )}
          </div>
          <D.Close className="rounded-lg p-1 text-muted hover:bg-panel-2 hover:text-ink" aria-label="关闭">
            <X className="size-5" />
          </D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}
