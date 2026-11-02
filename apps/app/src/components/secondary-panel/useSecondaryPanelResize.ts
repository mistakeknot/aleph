import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { RESET } from "jotai/utils";
import type { ImperativePanelHandle } from "react-resizable-panels";
import {
  SecondaryPanelWidthPercentAtomContext,
  threadSecondaryPanelResizingAtom,
} from "./threadSecondaryPanelAtoms";
import { usePinnedClassWriter } from "@/aleph/layoutProfiles";
import { usePanelResizeSnap } from "./usePanelResizeSnap";

type SecondaryPanelResizeHandler = (size: number) => void;

interface UseSecondaryPanelResizeArgs {
  isSecondaryPanelOpen: boolean;
  panelId: string;
  renderAsDrawer: boolean;
}

export function useSecondaryPanelResize({
  isSecondaryPanelOpen,
  panelId,
  renderAsDrawer,
}: UseSecondaryPanelResizeArgs) {
  const widthPercentAtom = useContext(SecondaryPanelWidthPercentAtomContext);
  const persistedWidthPercent = useAtomValue(widthPercentAtom);
  const setPersistedWidthPercent = useSetAtom(widthPercentAtom);
  const widthWriter = usePinnedClassWriter(widthPercentAtom);
  const setIsResizing = useSetAtom(threadSecondaryPanelResizingAtom);
  const secondaryPanelRef = useRef<HTMLElement>(null!);
  const secondaryResizablePanelRef = useRef<ImperativePanelHandle | null>(null);
  const lastSecondaryPanelSizeRef = useRef(persistedWidthPercent);
  const didPointerResizeRef = useRef(false);
  const handleSecondaryPanelPointerResize = useCallback(
    (leadingFraction: number) => {
      didPointerResizeRef.current = true;
      secondaryResizablePanelRef.current?.resize((1 - leadingFraction) * 100);
    },
    [],
  );
  const handleSecondaryPanelDragging = useCallback(
    (isDragging: boolean) => {
      setIsResizing(isDragging);
      if (isDragging) {
        didPointerResizeRef.current = false;
        widthWriter.pin();
        return;
      }
      if (
        didPointerResizeRef.current &&
        lastSecondaryPanelSizeRef.current > 0
      ) {
        widthWriter.commit(lastSecondaryPanelSizeRef.current);
      }
    },
    [setIsResizing, widthWriter],
  );
  const handleSecondaryPanelReset = useCallback(() => {
    setPersistedWidthPercent(RESET);
  }, [setPersistedWidthPercent]);
  const resizeHitTargetRef = usePanelResizeSnap({
    onResize: handleSecondaryPanelPointerResize,
    onDragging: handleSecondaryPanelDragging,
    onReset: handleSecondaryPanelReset,
  });

  const prevOpenRef = useRef(isSecondaryPanelOpen);
  useEffect(() => {
    if (prevOpenRef.current === isSecondaryPanelOpen) {
      return;
    }
    prevOpenRef.current = isSecondaryPanelOpen;

    const panel = secondaryResizablePanelRef.current;
    if (!panel) {
      return;
    }

    if (isSecondaryPanelOpen) {
      panel.expand(lastSecondaryPanelSizeRef.current);
    } else {
      panel.collapse();
    }
  }, [isSecondaryPanelOpen]);

  // The stored width changes when the width class (or a reset) selects a
  // different value; the mounted panel only reads defaultSize once. Only act
  // on a change after mount, never on the initial value.
  const prevPersistedWidthRef = useRef(persistedWidthPercent);
  useEffect(() => {
    if (prevPersistedWidthRef.current === persistedWidthPercent) {
      return;
    }
    prevPersistedWidthRef.current = persistedWidthPercent;
    const panel = secondaryResizablePanelRef.current;
    if (
      !panel ||
      !isSecondaryPanelOpen ||
      persistedWidthPercent <= 0 ||
      Math.abs(lastSecondaryPanelSizeRef.current - persistedWidthPercent) < 0.01
    ) {
      return;
    }
    panel.resize(persistedWidthPercent);
  }, [isSecondaryPanelOpen, persistedWidthPercent]);

  const handleSecondaryPanelResize = useCallback<SecondaryPanelResizeHandler>(
    (size) => {
      if (size <= 0) {
        return;
      }

      lastSecondaryPanelSizeRef.current = size;
      secondaryPanelRef.current?.style.setProperty(
        "--secondary-swipe-width",
        `${size}cqw`,
      );
    },
    [],
  );

  useLayoutEffect(() => {
    const panel =
      secondaryPanelRef.current?.closest<HTMLElement>("[data-panel]");
    const size = Number.parseFloat(panel?.style.flexGrow ?? "");
    if (Number.isFinite(size)) handleSecondaryPanelResize(size);
  }, [
    handleSecondaryPanelResize,
    isSecondaryPanelOpen,
    panelId,
    renderAsDrawer,
  ]);

  return {
    handleSecondaryPanelResize,
    resizeHitTargetRef,
    persistedWidthPercent,
    secondaryPanelRef,
    secondaryResizablePanelRef,
  };
}
