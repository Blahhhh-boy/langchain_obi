import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { run } from "./workflow.graph.js"; 
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  const { input, state } = req.body;

  try {
    const result = await run(input, state || {});
    
    console.log("Workflow result:", result);
    if (result.__interrupt__) {
     return res.json({ 
        type: "prompt", 
        prompt: result.__interrupt__[0].value.prompt, 
        state: result 
      });
    } else {
      return res.json({ 
        type: "final", 
        message: "Flow complete", 
        state: result 
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(3001, () => {
  console.log("🌐 Server running at http://localhost:3001");
});
