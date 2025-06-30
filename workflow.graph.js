import {
  END,
  Graph,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
import z from "zod";
import * as readline from "node:readline/promises";
import { interrupt } from "@langchain/langgraph";
import axios from "axios";
import {
  agent_intro,
  bundleInstruction,
  classifyInstruction,
  contactInfoInstruction,
  indiScheduleInstruction,
  PaymentProcessingInformation,
  productTypeInstruction,
} from "./utils/instructions.js";
import { jsonParser } from "./utils/utils.js";
import CryptoJS from 'crypto-js';
import { request } from "node:http";



// export const terminal = readline.createInterface({
//   input: process.stdin,
//   output: process.stdout,
// });

dotenv.config();
let currentNode = null;
const memory = [];
const messageObj = (role, input) => ({ role, content: input });

// --- LLM Setup ---
const llm = new ChatOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-4o",
});

const stateSchema = z.object({
  input: z.string(),
  flow: z.enum(["booking", "general"]),
  done: z.boolean(),
  currentNode: z.string().optional(), // <--- NEW
  collected: z.object({
    A: z.any(),
    D: z.any(),
  }),
  scheduleData: z.object({
    A: z.any(),
    D: z.any(),
  }),
  productid: z.enum(["ARRIVALONLY", "DEPARTURE", "ARRIVALBUNDLE"]),
  passengerDetails:z.object({
    adults: z.any(),
    children: z.any()
  }),
  contactInfo: z.object({
    title: z.string(),
    firstname: z.string(),
    lastname: z.string(),
    email: z.string(),
    phone: z.string(),
  }),
  reseravationData: z.any(),
  paymentInformation:z.any(),
  messages: z.array(),
  paymentHtml: z.string().optional(),
});

const classify = async (state) => {
  const prompt = messageObj(
    "system",
    `
    ${classifyInstruction}`
  );
  const userMessage = messageObj("user", state.input);
  memory.push(userMessage);

  const res = await llm.invoke([...memory, prompt]);
  console.log(res.content);
  const flow = res.content.toLowerCase();
  console.log("llm flow : ", flow);

  return { flow };
};

const scheduleStep = async (state) => {
  const responseHandler = {
    A: null,
    D: null,
  };
  if (
    state.productid === "ARRIVALONLY" ||
    state.productid === "ARRIVALBUNDLE"
  ) {
    responseHandler["A"] = await getSchedule(state.collected.A);
  }
  if (state.productid === "DEPARTURE" || state.productid === "ARRIVALBUNDLE") {
    responseHandler["D"] = await getSchedule(state.collected.D);
  }

  return {
    done: true,
    scheduleData: responseHandler,
    currentNode: "schedulecall",
  };
};

const reserveStep = async (state) => {
  console.log(state);
  const direction = state.productid === "ARRIVALONLY" ? "A" : "D";
  const response = await reserveCart({
    childtickets: state.collected[direction].tickets.childtickets,
    adulttickets: state.collected[direction].tickets.adulttickets,
    scheduleData: state.scheduleData,
    productid: state.productid,
  });
  console.log("reserver response : ", response);
  return { reseravationData: response, currentNode: "reservation" };
};

const answerGeneral = async (state) => {
  const userMessage = messageObj("user", state.input);
  const res = await llm.invoke(memory);
  const asistantMessage = messageObj("assistant", res.content);
  memory.push(asistantMessage);

  console.log("general answer : ", res.content);
  return {};
};

const infoCollector = async (state) => {
  currentNode = "scheduleinfo";
  const isBundle = state.productid === "ARRIVALBUNDLE";
  let currentDirection;

  if (isBundle) {
    if (!state.collected.A) {
      currentDirection = "ARRIVAL";
    } else if (!state.collected.D) {
      currentDirection = "DEPARTURE";
    }
  }

  const prompt = `${agent_intro} 
  ${isBundle ? bundleInstruction(currentDirection) : indiScheduleInstruction}
  `;

  const userMessage = messageObj("user", state.input);
  memory.push(userMessage);

  const response = await llm.invoke([...memory, messageObj("system", prompt)]);
  let parsed = await jsonParser(response.content);

  // console.log("🔍 Parsed object:", parsed);

  memory.push(messageObj("assistant", parsed.message));

  if (!parsed?.done) {
    return interrupt({ prompt: parsed.message });
  }
  // Update collected directions
  const updatedCollected = {
    ...state.collected,
    A: parsed.collected["A"],
    D: parsed.collected["D"],
  };

  const isArrivalDone = updatedCollected.A;
  const isDepartureDone = updatedCollected.D;
  let done = parsed.done;

  if (isBundle) {
    done = isArrivalDone && isDepartureDone;
  }

  return {
    done,
    collected: updatedCollected,
    currentNode: "scheduleinfo",
  };
};

const productType = async (state) => {
  currentNode = "startBooking";
  const prompt = `${agent_intro} ${productTypeInstruction}`;
  const userMessage = messageObj("user", state.input);
  const systemMessage = messageObj("system", prompt);
  memory.push(userMessage);
  const response = await llm.invoke([...memory, systemMessage]);
  let parsed = await jsonParser(response.content);
  if (!parsed?.done) {
    return interrupt({ prompt: parsed.message });
  }
  return {
    done: parsed.done,
    collected: { ...state.collected, productid: parsed.collected.productid },
    productid: parsed.collected.productid,
    currentNode: "startBooking",
  };
};

const contactHandler = async (state) => {
  const userMessage = messageObj("user", state.input);
  memory.push(userMessage);

  currentNode = "contactinfo";
  const adulttickets = state.collected?.A?.tickets ? state.collected.A.tickets.adulttickets: state.collected.D.tickets.adulttickets
  const childtickets = state.collected?.A?.tickets ? state.collected.A.tickets.childtickets: state.collected.D.tickets.childtickets
  const prompt = `${agent_intro} ${contactInfoInstruction(adulttickets,childtickets)}`;
  const response = await llm.invoke([...memory, messageObj("system", prompt)]);
  let parsed = await jsonParser(response.content);

  memory.push(messageObj("assistant", parsed.message));

  if (!parsed?.done) {
    return interrupt({ prompt: parsed.message });
  }
  console.log(parsed,"passenger details")
  return {
    done: parsed.done,
    contactInfo: parsed.contact,
    passengerDetails: parsed.passengerDetails,
    currentNode: "contactinfo",
  };
};

const setContactStep = async (state) => {
  const response = await setContact({
    ...state.contactInfo,
    reseravationData: state.reseravationData,
  });
  console.log("setcontact response ", response);
  return {};
};

const paymentHandler = async (state) => {
  const userMessage = messageObj("user",state.input);
  memory.push(userMessage)

  currentNode = 'paymentinfo';
  const prompt = `${agent_intro} ${PaymentProcessingInformation}`;
  const response = await llm.invoke([...memory,messageObj("system",prompt)]);
  let parsed = await jsonParser(response.content);

  memory.push(messageObj("assistant",parsed.message));

  if(!parsed?.done){
    return interrupt({ prompt: parsed.message });
  }

  return {
    done: parsed.done,
    paymentInformation: parsed.paymentInformation,
    currentNode: "paymentinfo"
  }
}

const paymentManager = async (state) => {
  console.log(JSON.stringify(state),"state")
  const response = await processPayment({state:state })
  return response
}

const productSuccess = async (state) => {
  console.log("congrats your product is booked");
  return {};
};

const graph = new StateGraph({
  state: stateSchema,
  messages: memory,
});

graph.addNode("classify", classify);
graph.addNode("general", answerGeneral);
graph.addNode("startBooking", productType);
graph.addNode("schedulecall", scheduleStep);
graph.addNode("reservation", reserveStep);
graph.addNode("scheduleinfo", infoCollector);
graph.addNode("contactinfo", contactHandler);
graph.addNode("setcontact", setContactStep);
graph.addNode("paymentinfo", paymentHandler);
graph.addNode("processpayment",paymentManager)
graph.addNode("productend", productSuccess);

graph.addConditionalEdges(START, (state) => {
  return currentNode || "classify";
});

graph.addConditionalEdges("classify", (state) => {
  if (state.flow) return state.flow === "booking" ? "startBooking" : "general";
  return "classify";
});

graph.addConditionalEdges("startBooking", (state) => {
  return state.done ? "scheduleinfo" : "startBooking";
});

graph.addConditionalEdges("scheduleinfo", (state) => {
  return state.done ? "schedulecall" : "scheduleinfo";
});

graph.addConditionalEdges("contactinfo", (state) => {
  return state.done ? "setcontact" : "contactinfo";
});

graph.addConditionalEdges("paymentinfo",(state)=>{
  return state.done ? "processpayment" : "paymentinfo"
})

graph.addEdge("general", END);
graph.addEdge("schedulecall", "reservation");
graph.addEdge("reservation", "contactinfo");
graph.addEdge("setcontact", "paymentinfo");
graph.addEdge("processpayment","productend")
graph.addEdge("productend", END);

export const compiledGraph = graph.compile({
  checkpointer: new MemorySaver(),
  start: (state) => state.currentNode || START,
});

export async function run(input, previousState = {}) {
  const cfg = { configurable: { thread_id: "booking-session" } };

  const initState = {
    ...previousState,
    input,
  };

  const state = await compiledGraph.invoke(initState, cfg);

  console.log('STATE:', JSON.stringify(state));

  if (state.__interrupt__) {
    const prompt = state.__interrupt__[0].value.prompt;

    // 👉 Instead of terminal.question, return the prompt + state
    return {
      type: "prompt",
      prompt,
      state,
    };
  }

  return {
    type: "final",
    message: "Flow completed",
    state,
  };
}

// async function run(input, previousState = {}) {
//   const cfg = { configurable: { thread_id: "booking-session" } };

//   const initState = {
//     ...previousState,
//     input,
//   };

//   const state = await compiledGraph.invoke(initState, cfg);

//   if (state.__interrupt__) {
//     const prompt = state.__interrupt__[0].value.prompt;
//     const reply = await terminal.question(`🧠 ${prompt} `);
//     // 👇 Re-invoke with updated state, continuing from last point
//     return await run(reply, {
//       ...state,
//       input: reply,
//     });
//   }

//   console.log("🎯 Final State:", state);
// }
// --- Main Loop ---
// async function mainLoop() {
//   while (true) {
//     const input = await terminal.question("you: ");
//     if (input.toLowerCase().trim() === "exit") {
//       console.log("👋 Exiting...");
//       process.exit(0);
//     }
//     await run(input);
//   }
// }

// mainLoop();

export async function getSchedule({
  direction,
  airportid,
  traveldate,
  flightId,
}) {
  // console.log("hey from get schedule");
  const request = {
    username: process.env.STATIC_USERNAME,
    sessionid: process.env.STATIC_SESSIONID,
    failstatus: 0,
    request: {
      direction: direction,
      airportid: airportid,
      traveldate: traveldate,
    },
  };
  try {
    const response = await axios.post(
      `${process.env.DEVSERVER}/getschedule`,
      request
    );
    const result = response?.data?.data?.flightschedule?.filter(
      (flightDetail) => flightDetail?.flightId === flightId
    );
    return result;
  } catch (error) {
    console.log(error);
  }
  return { message: "we have an error" };
}

export async function reserveCart({
  adulttickets,
  childtickets,
  scheduleData,
  productid,
}) {
  const scheduleBuilder = {
    arrivalscheduleid: 0,
    departurescheduleid: 0,
  };

  if (productid === "ARRIVALONLY" || productid === "ARRIVALBUNDLE") {
    scheduleBuilder.arrivalscheduleid = scheduleData.A[0].scheduleId;
  }
  if (productid === "DEPARTURELOUNGE" || productid === "ARRIVALBUNDLE") {
    scheduleBuilder.departurescheduleid = scheduleData?.D[0]?.scheduleId;
  }
  // console.log(scheduleBuilder, scheduleData);
  const request = {
    failstatus: 0,
    sessionid: process.env.STATIC_SESSIONID,
    username: process.env.STATIC_USERNAME,
    request: {
      adulttickets: adulttickets,
      arrivalscheduleid: scheduleBuilder.arrivalscheduleid,
      cartitemid: 0,
      childtickets: childtickets,
      departurescheduleid: scheduleBuilder.departurescheduleid,
      distributorid: "",
      paymenttype: "GUESTCARD",
      productid: productid,
      ticketsrequested: adulttickets + childtickets,
    },
  };
  console.log(request,"::reserve cart req")
  try {
    const response = await axios.post(
      `${process.env.DEVSERVER}/reservecartitem`,
      request
    );
    return response.data.data;
  } catch (error) {
    console.log(error);
  }
  return "we have an error in reserving cart";
}

export async function setContact({
  email,
  firstname,
  lastname,
  phone,
  reseravationData,
}) {
  const request = {
    failstatus: 0,
    request: {
      contact: {
        cartitemid: reseravationData?.cartitemid,
        email,
        firstname,
        lastname,
        phone,
        title: "MR.",
      },
    },
    sessionid: process.env.STATIC_SESSIONID,
    username: process.env.STATIC_USERNAME,
  };

  try {
    const response = await axios.post(
      `${process.env.DEVSERVER}/setcontact`,
      request
    );
    return "your primary contacts are submitted";
  } catch (error) {
    console.log(error);
  }
  return "we have an error in reserving cart";
}

export async function processPayment({ state }) {

  const getCartItemsReq = {
    failstatus:0,
    request:{},
    username:process.env.STATIC_USERNAME,
    sessionid:process.env.STATIC_SESSIONID
  }

  const getCartItems = await axios.post(`${process.env.DEVSERVER}/getcartitems`,getCartItemsReq)
  console.log(JSON.stringify(getCartItems.data),"::getCartItems")

  const adulttickets = state.collected?.A?.tickets ? state.collected.A.tickets.adulttickets: state.collected.D.tickets.adulttickets
  const childtickets = state.collected?.A?.tickets ? state.collected.A.tickets.childtickets: state.collected.D.tickets.childtickets
  const amount = state.reseravationData.retail
  const passengers = []
  for (let i = 0; i < adulttickets; i++) {
    passengers.push({
      dob: state.passengerDetails.adults[i].dob || "",
      email: state.passengerDetails.adults[i].email,
      firstname: state.passengerDetails.adults[i].firstname,
      lastname: state.passengerDetails.adults[i].lastname,
      passengertype: "ADULT",
      phone: state.contactInfo.phone,
      title: state.passengerDetails.adults[i].title,
    });
  }
  for(let i = 0; i < childtickets; i++){
    passengers.push({
      dob:state.passengerDetails.children[i].dob,
      email:undefined,
      firstname: state.passengerDetails.children[i].firstname,
      lastname: state.passengerDetails.children[i].lastname,
      passengertype: "CHILD", 
      phone: state.contactInfo.phone,
      title: state.passengerDetails.children[i].title
    })
  }
  const orderReq = {
    failstatus:0,
    request:{
      source:"OBI-MAIN",
      amount:amount
    },
    sessionid:process.env.STATIC_SESSIONID,
    username:process.env.STATIC_USERNAME
  }

  const orderidres = await axios.post(`${process.env.DEVSERVER}/getorderid`,orderReq)

  function formatCreditCardExpiryFAC(cardMonth, cardYear) {
    let cardExpiry = cardMonth + cardYear?.slice(-2);
    return cardExpiry;
  }
  const encryptData = (data, iv, key) => {
    // Ensure key is a WordArray
    const keyWA = typeof key === "string" ? CryptoJS.enc.Base64.parse(key) : key;
    const value = CryptoJS.AES.encrypt(
      CryptoJS.enc.Utf8.parse(data),
      keyWA,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    return value.ciphertext.toString(CryptoJS.enc.Base64);
  };

  const encryptCardDetails = (cardholderDetails, key) => {
      const iv = CryptoJS.lib.WordArray.random(16);
      const cardNumber = encryptData(cardholderDetails?.cardnumber, iv, key);
      const cardHolderName = encryptData(cardholderDetails?.cardholdername, iv, key);
      const cvv = encryptData(cardholderDetails?.cvv, iv, key);
      const [month, year] = cardholderDetails?.expirydate?.split("/");
      const expiryDate = encryptData(formatCreditCardExpiryFAC(month, year), iv, key);

      return {
        iv: CryptoJS.enc.Base64.stringify(iv),
        cardNumber: cardNumber,
        cardHolderName: cardHolderName,
        cvv: cvv,
        expiryDate: expiryDate,
       };
  };

  const encryptedData = encryptCardDetails(state.paymentInformation, process.env.STATIC_ENCRYPTION_KEY);
  const direction = state.productid === "ARRIVALONLY" ? "A" : "D";

  const commonCart = [{
        adulttickets:adulttickets,
        amount:amount,
        arrivalscheduleid:direction === "A" ? state.scheduleData?.A[0].scheduleId : 0,
        cartitemid:state.reseravationData.cartitemid,
        childtickets:childtickets,
        departurescheduleid:direction === "D"? state.scheduleData?.D[0].scheduleId : 0,
        groupbooking:"N",
        groupid:"NA",
        infanttickets:0,
        optional:{ occasioncomment:"", paddlename : "AI Agent" , specialoccasion: undefined },
        passengers:passengers,
        primarycontact:state.contactInfo,
        productid:state.productid,
        referencenumber:'',
        secondarycontact: {
          email: "",
          firstname: "",
          lastname: "",
          phone: "",
          title: "MR"
        }
      }]

  const addconfirmationLogReq = {
    failstatus:0,
    request:{
      affiliateid: "!",
      cart:commonCart,
      distributorid: "",
      httpreferrer: "",
      orderid: orderidres.data.data.orderid,
      payment:{
        charged:"Y",
        creditcard:{
          amount:amount,
          authorizationnumber:123456,
          cardholdername: state.paymentInformation.cardholdername,
          cardnumber: state.paymentInformation.cardnumber.slice(-4),
          cardtype: state.paymentInformation.cardtype,
          currency:"USD",
          email:state.paymentInformation.cardholderemail,
        },
        paymenttype: "GUESTCARD",
      },
      referrerid:"",
      sendconfirmation:{
        copyto:"",
        sendto:state.contactInfo.email,
      },
      subaffiliateid:0         
    },
    sessionid:process.env.STATIC_SESSIONID,
    username:process.env.STATIC_USERNAME
  }

  const processCardReq = {
    failstatus: 0,
    request: {
      actiontype: "CHARGECARD",
      creditcard: {
        amount: amount,
        cardtype: state.paymentInformation.cardtype, 
        cardnumber: encryptedData.cardNumber, 
        cardholder: encryptedData.cardHolderName, 
        expirydate: encryptedData.expiryDate, 
        cvv: encryptedData.cvv,
        email: state.paymentInformation.cardholderemail,
        expirydate: encryptedData.expiryDate,
        iv: encryptedData.iv, 
      },
    orderid: orderidres.data.data.orderid,
    },
    sessionid: process.env.STATIC_SESSIONID,
    username: process.env.STATIC_USERNAME,
  }

  console.log(processCardReq,"processCardReq")

  const processCard = await axios.post(`${process.env.DEVSERVER}/processcard`, processCardReq);

  console.log("processCard response : ", processCard.data);

  state.paymentHtml = processCard.data.data?.html || "";

  const confirmCartReq = {
    failstatus:0,
    request:{
      affiliateid: "!",
      cart: commonCart,
      distributorid: "",
      httpreferrer: "",
      payment:{
        charged:"Y",
        creditcard:{
          amount:amount,
          authorizationnumber:"123456",
          cardholder:state.paymentInformation.cardholdername,
          cardnumber: state.paymentInformation.cardnumber.slice(-4),
          cardtype: state.paymentInformation.cardtype,
          currency:"USD",
          email: state.paymentInformation.cardholderemail|| "nikunjrathi2308@gmail.com",
        },
        paymenttype: "GUESTCARD",
      },
      referrerid:"",
      sendconfirmation:{
        copyto:"",
        sendto:state.contactInfo.email,
      },
      subaffiliateid:0,
    },
    sessionid: process.env.STATIC_SESSIONID,
    username: process.env.STATIC_USERNAME
  }

  console.log("confirmcartReq : ", JSON.stringify(confirmCartReq));

  const confirmCart = await axios.post(`${process.env.DEVSERVER}/confirmcart`, confirmCartReq);

  console.log("confirmCart response : ", confirmCart.data, "reserve cart response : ", state.reseravationData,"confirmCartReq cart: ", confirmCartReq.request.cart);

  return state;
}
