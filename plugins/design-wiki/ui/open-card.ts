const TASK_PANEL = "/plugins/tasks/tasks/task/";

export function openCard(key: string) {
  window.location.assign(`${TASK_PANEL}${encodeURIComponent(key)}`);
}
