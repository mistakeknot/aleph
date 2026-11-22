import { threadCpuUsage } from "node:process";

export function cpuTimeMs(): number {
  const cpu = threadCpuUsage();
  return (cpu.user + cpu.system) / 1000;
}
