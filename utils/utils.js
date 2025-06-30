export const jsonParser = async (content) => {
  let parsed;
    try {
    parsed = await JSON.parse(content);
  } catch (error) {
    console.error("JSON parse error:", error);
  }
  return parsed;
};
