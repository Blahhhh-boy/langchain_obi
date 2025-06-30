import { tool } from "@langchain/core/tools";
import z from "zod";

const multiply = tool(
  async ({ num1, num2 }) => {
    return `${num1 * num2}`;
  },
  {
    name: "multiply",
    description: "multiplies two numbers",
    schema: z.object({
      num1: z.number().describe("first number"),
      num2: z.number().describe("second number"),
    }),
  }
);
const add = tool(
  async ({ num1, num2 }) => {
    return `${num1 + num2}`;
  },
  {
    name: "add",
    description: "add two numbers",
    schema: z.object({
      num1: z.number().describe("first number"),
      num2: z.number().describe("second number"),
    }),
  }
);
const subtract = tool(
  async ({ num1, num2 }) => {
    return `${num1 - num2}`;
  },
  {
    name: "subtract",
    description: "subtracts two numbers",
    schema: z.object({
      num1: z.number().describe("first number"),
      num2: z.number().describe("second number"),
    }),
  }
);

export const tools = [multiply, add, subtract];
// return key value pair object toolname: tool
export const toolsByName = Object.fromEntries(tools.map((tool) => [tool.name , tool]));