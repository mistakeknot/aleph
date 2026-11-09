import { atom } from "jotai";
export const hullDesignationsAtom = atom<Readonly<Record<string, string>>>({});
export const hullNameDesignationsAtom = atom<Readonly<Record<string, string>>>(
  {},
);
