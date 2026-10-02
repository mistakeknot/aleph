import { contextBridge, ipcRenderer } from "electron";
import {
  BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL,
  overlayOpenPanelResultSchema,
  type BbOverlayApi,
} from "./overlay-contract.js";

const bbOverlay: BbOverlayApi = {
  async openPanel(request) {
    const result: unknown = await ipcRenderer.invoke(
      BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL,
      { panelId: request.panelId, pluginId: request.pluginId },
    );
    const parsed = overlayOpenPanelResultSchema.safeParse(result);
    return parsed.success
      ? parsed.data
      : { ok: false, reason: "Unexpected overlay response." };
  },
};

contextBridge.exposeInMainWorld("bbOverlay", bbOverlay);
