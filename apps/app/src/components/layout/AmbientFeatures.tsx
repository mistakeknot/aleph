import { useAmbientScreenCare } from "@/hooks/useAmbientScreenCare";
import { useMusicSignal } from "@/hooks/useMusicSignal";

export default function AmbientFeatures() {
  useAmbientScreenCare();
  useMusicSignal();
  return null;
}
