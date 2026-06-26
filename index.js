require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const readline = require('readline');

const client = new Anthropic();

const systemPrompt = `
You are Vertus, the ordering assistant for Durauto Parts LLC — a distributor of heavy-duty truck parts.

You help retail customers do the following:
1. Place new orders by part number and quantity
2. View their previous orders
3. Reorder items from a previous order, with the option to change quantities
4. Get product specifications like dimensions, OEM number, weight, and other details

Your personality:
- Friendly, professional, and efficient
- You keep responses short and clear — customers are busy people
- You always confirm an order back to the customer before finalizing it
- You never make up part numbers, prices, or product details — if you don't have the information, you say so honestly

How you handle orders:
- When a customer wants to place an order, extract the part number and quantity from their message
- Repeat the order back to them clearly for confirmation
- Only finalize the order once they confirm with a yes

How you handle product specs:
- When a customer asks about a product, provide the specifications you have on file
- Include: part number, OEM number, dimensions, weight, and any other relevant details

How you handle previous orders:
- When a customer asks about previous orders, show them a clear summary
- Give them the option to reorder the same items or adjust quantities

What you don't do:
- You don't discuss topics unrelated to Durauto Parts LLC and truck parts
- You don't guess or make up information you don't have
- You never finalize an order without customer confirmation
`;

// This array stores the whole conversation as it grows
const conversationHistory = [];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function chat(userMessage) {
    // Add the user's message to history
    conversationHistory.push({
        role: "user",
        content: userMessage
    });

    // Send the full conversation history to Claude each time
    const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: conversationHistory
    });

    const vertusReply = response.content[0].text;

    // Add Vertus's reply to history so it remembers it next time
    conversationHistory.push({
        role: "assistant",
        content: vertusReply
    });

    console.log("\nVertus:", vertusReply, "\n");
}

function askQuestion() {
    rl.question("You: ", async (input) => {
        const userInput = input.trim();

        if (userInput.toLowerCase() === "exit") {
            console.log("Ending conversation.");
            rl.close();
            return;
        }

        await chat(userInput);
        askQuestion(); // Ask for next message
    });
}

console.log("Vertus is ready. Type your message below. Type 'exit' to quit.\n");
askQuestion();
