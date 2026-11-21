import type { PreferredFit } from "@/lib/fitPreferences";

export interface PresetModel {
  id: string;
  name: string;
  avatarUrl: string;
  heightCm: number;
  weightKg: number;
  preferredFit: PreferredFit;
  summary: string;
}

export const PRESET_MODELS: readonly PresetModel[] = [
  {
    id: "model-a",
    name: "Model A",
    avatarUrl: "/models/model-a.jpg",
    heightCm: 170,
    weightKg: 58,
    preferredFit: "slim",
    summary: "170 cm · 58 kg · Slim",
  },
  {
    id: "model-b",
    name: "Model B",
    avatarUrl: "/models/model-b.jpg",
    heightCm: 176,
    weightKg: 70,
    preferredFit: "regular",
    summary: "176 cm · 70 kg · Regular",
  },
  {
    id: "model-c",
    name: "Model C",
    avatarUrl: "/models/model-c.jpg",
    heightCm: 165,
    weightKg: 54,
    preferredFit: "regular",
    summary: "165 cm · 54 kg · Regular",
  },
] as const;

export function isPresetModelUrl(url: string): boolean {
  return PRESET_MODELS.some((model) => model.avatarUrl === url);
}
