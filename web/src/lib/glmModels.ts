import type { AvailableAgent } from "@/hooks/useAvailableAgents";

export const GLM_AGENT_NAME = "glm";

export const GLM_MODEL_OPTIONS = [
  { id: "glm-5.3", displayName: "5.3" },
  { id: "glm-5.3-flash", displayName: "5.3 Flash" },
] as const;

export const DEFAULT_GLM_MODEL = GLM_MODEL_OPTIONS[0].id;

export function isGlmAgent(agent: Pick<AvailableAgent, "name"> | null | undefined): boolean {
  return agent?.name === GLM_AGENT_NAME;
}

export function isGlmModel(model: string | null | undefined): boolean {
  return GLM_MODEL_OPTIONS.some((option) => option.id === model);
}
