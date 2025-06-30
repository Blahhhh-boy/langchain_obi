import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
import { tools, toolsByName } from "./tools.js";
import { ToolMessage } from "@langchain/core/messages";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

dotenv.config();

const llm = new ChatOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-4.1-2025-04-14",
});

const llmWithTools = llm.bindTools(tools);

async function llmCall(state) {
  const result = await llmWithTools.invoke([
    {
      role: "system",
      content:
        "you are helpful assistant tasked with performing airthemtic opraiton based on provided tools",
    },
    ...state.messages,
  ]);

  return {
    messages: [result],
  };
}

async function toolNode(state) {
  const results = [];
  const lastMessage = state.messages.at(-1);

  if (lastMessage?.tool_calls?.length) {
    for (const toolCall of lastMessage.tool_calls) {
      const tool = toolsByName[toolCall.name];
      const observation = await tool.invoke(toolCall.args);
      results.push(
        new ToolMessage({
          content: observation,
          tool_call_id: toolCall.id,
        })
      );
    }
  }
  return { messages: results };
}

function shouldContinue(state) {
  const messages = state.messages;
  const lastMessage = messages.at(-1);
  if (lastMessage?.tool_calls?.length) {
    return "Action";
  }
  return "__end__";
}

// Build workflow
const agentBuilder = new StateGraph(MessagesAnnotation)
  .addNode("llmCall", llmCall)
  .addNode("tools", toolNode)
  // Add edges to connect nodes
  .addEdge("__start__", "llmCall")
  .addConditionalEdges(
    "llmCall",
    shouldContinue,
    {
      // Name returned by shouldContinue : Name of next node to visit
      "Action": "tools",
      "__end__": "__end__",
    }
  )
  .addEdge("tools", "llmCall")
  .compile();


  const userInput = 'Add 3 and 4'
  // Invoke
  const messages = [{
    role: "user",
    content: userInput
  }];
  
  console.log('running predefined user input : ' , userInput)
const result = await agentBuilder.invoke({ messages });
console.log(result.messages.at(-1).content);