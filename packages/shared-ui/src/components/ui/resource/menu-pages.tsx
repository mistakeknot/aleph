import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Icon } from "../icon";

interface ResourceMenuPage {
  id: string;
  label: string;
  trigger: ReactNode;
  content: ReactNode;
}

export function ResourceMenuPages({
  label,
  pages,
  trigger,
  actions,
  className,
}: {
  label: string;
  pages: readonly ResourceMenuPage[];
  trigger: (open: boolean) => ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pageId, setPageId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const returnPageRef = useRef<string | null>(null);
  const page = pages.find((candidate) => candidate.id === pageId);
  const goBack = () => {
    returnPageRef.current = pageId;
    setPageId(null);
  };

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const content = contentRef.current;
      if (pageId) {
        content
          ?.querySelector<HTMLElement>(
            '[data-resource-menu-page-content] :is(input, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"])',
          )
          ?.focus();
      } else if (returnPageRef.current) {
        const item = Array.from(
          content?.querySelectorAll<HTMLElement>("[data-resource-menu-page]") ??
            [],
        ).find(
          (candidate) =>
            candidate.dataset.resourceMenuPage === returnPageRef.current,
        );
        item?.closest<HTMLElement>('[role="menuitem"]')?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, pageId]);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPageId(null);
          returnPageRef.current = null;
        }
      }}
    >
      <DropdownMenuTrigger asChild>{trigger(open)}</DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        align="end"
        mobileTitle={page?.label ?? label}
        className={className}
        onKeyDown={(event) => {
          if (
            !page &&
            event.key === "ArrowRight" &&
            event.target instanceof Element
          ) {
            const nextPage = event.target
              .closest('[role="menuitem"]')
              ?.querySelector<HTMLElement>("[data-resource-menu-page]")
              ?.dataset.resourceMenuPage;
            if (nextPage) {
              event.preventDefault();
              setPageId(nextPage);
            }
          }
          if (
            page &&
            event.key === "ArrowLeft" &&
            !(event.target instanceof HTMLInputElement)
          ) {
            event.preventDefault();
            goBack();
          }
        }}
      >
        {page ? (
          <>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                goBack();
              }}
            >
              <Icon name="ChevronLeft" className="size-4" aria-hidden />
              {label}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="contents" data-resource-menu-page-content>
              {page.content}
            </div>
          </>
        ) : (
          <>
            {actions}
            {pages.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                onSelect={(event) => {
                  event.preventDefault();
                  setPageId(entry.id);
                }}
              >
                <span className="contents" data-resource-menu-page={entry.id}>
                  {entry.trigger}
                </span>
                <Icon
                  name="ChevronRight"
                  className="ml-auto size-4 shrink-0"
                  aria-hidden
                />
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
