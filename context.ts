export function getContextWindow(modelName: string): number {
  if (
    modelName.includes("claude-sonnet-4-5") ||
    modelName.includes("claude-haiku-4-5") ||
    modelName.includes("claude-opus-4-5")
  ) {
    return 2_500;
  }

  
  if (
    modelName.includes("claude-opus-4") ||
    modelName.includes("claude-sonnet-4") ||
    modelName.includes("claude-3-7-sonnet")
  ) {
    return 200_000; 
  }

  
  if (modelName.includes("claude-3-5")) {
    return 200_000; 
  }

  
  if (modelName.includes("claude-3-haiku")) {
    return 200_000; 
  }

  
  return 200_000;
}

export function getCompactionThreshold(modelName: string): number {
  const contextWindow = getContextWindow(modelName);
  return Math.floor(contextWindow * 0.8); 
}
