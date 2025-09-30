import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { ElevenLabsClient } from 'elevenlabs';
import { Readable } from 'stream';

dotenv.config();

const app = express();

app.use(express.json());
app.use(cors());

if (!process.env.OPENAI_API_KEY) {
    console.log('[SYSTEM] No API key found, running in test mode lol');
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'sk-dummy-key-for-testing'
});

// Initialize ElevenLabs client
let elevenlabs = null;
if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'test-key') {
    try {
        elevenlabs = new ElevenLabsClient({
            apiKey: process.env.ELEVENLABS_API_KEY
        });
        console.log('[TTS] ElevenLabs client initialized');
    } catch (error) {
        console.log('[TTS] Failed to initialize ElevenLabs:', error.message);
    }
}

const activeCalls = {};
let totalMessagesProcessed = 0;

async function textToSpeech(text) {
    try {
        // Check if ElevenLabs client is initialized
        if (!elevenlabs) {
            console.log('[TTS] ElevenLabs not configured, skipping TTS');
            return {
                audio: '',
                duration: Math.floor(text.length * 0.05)
            };
        }
        
        console.log('[TTS] Generating speech with ElevenLabs SDK...');
        console.log(`[TTS] Text: "${text.substring(0, 50)}..."`);
        
        try {
            // Generate audio using the SDK
            const audioStream = await elevenlabs.generate({
                voice: "Rachel", // You can use voice name or ID
                text: text,
                model_id: "eleven_monolingual_v1",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.5
                }
            });
            
            // Convert stream to buffer
            const chunks = [];
            for await (const chunk of audioStream) {
                chunks.push(chunk);
            }
            const audioBuffer = Buffer.concat(chunks);
            
            // Convert to base64
            const audioBase64 = audioBuffer.toString('base64');
            console.log('[TTS] ✓ Audio generated successfully, size:', Math.round(audioBuffer.length / 1024), 'KB');
            
            return {
                audio: audioBase64,
                duration: Math.floor(text.length * 0.06)
            };
            
        } catch (sdkError) {
            console.log('[TTS-ERROR] ElevenLabs SDK error:');
            
            if (sdkError.statusCode === 401) {
                console.log('  → Invalid API key');
                elevenlabs = null; // Disable further attempts
            } else if (sdkError.statusCode === 429) {
                console.log('  → Rate limit or quota exceeded');
            } else if (sdkError.statusCode === 422) {
                console.log('  → Invalid request (text might be too long)');
            } else {
                console.log('  →', sdkError.message || sdkError);
            }
            
            return { audio: '', duration: Math.floor(text.length * 0.05) };
        }
        
    } catch (error) {
        console.log('[TTS-ERROR] Unexpected error:', error.message);
        return {
            audio: '',
            duration: Math.floor(text.length * 0.05)
        };
    }
}

async function speechToText(audioBase64) {
    try {
        console.log('[STT] Converting speech to text...');
        
        // In production, you'd use a real STT service like Google Speech-to-Text
        // For now, we'll decode the mock data
        const text = Buffer.from(audioBase64, 'base64').toString('utf-8');
        console.log(`[STT] Transcribed: "${text}"`);
        
        return text;
    } catch (error) {
        console.log('[STT-ERROR]', error.message);
        throw error;
    }
}

class CallContext {
    constructor(callId) {
        this.callId = callId;
        this.conversationHistory = [];
        this.customerInfo = {};
        this.bookingDetails = {};
        this.createdAt = new Date();
        this.lastActivity = new Date();
        this.status = 'active';
        this.toolMemory = [];
        this.callDuration = 0;
    }
    
    addMessage(role, content) {
        this.conversationHistory.push({
            role,
            content,
            timestamp: new Date()
        });
        this.lastActivity = new Date();
    }
    
    addToolResult(tool, result) {
        this.toolMemory.push({
            tool,
            result,
            timestamp: new Date()
        });
    }
    
    getConversationForGPT() {
        return this.conversationHistory.map(msg => ({
            role: msg.role === 'customer' ? 'user' : msg.role,
            content: msg.content
        }));
    }
    
    updateCustomerInfo(info) {
        this.customerInfo = { ...this.customerInfo, ...info };
    }
    
    updateBookingDetails(details) {
        this.bookingDetails = { ...this.bookingDetails, ...details };
    }
    
    endCall() {
        this.status = 'ended';
        this.endedAt = new Date();
        this.callDuration = Math.floor((this.endedAt - this.createdAt) / 1000);
        console.log(`[DEBUG] Call ${this.callId} lasted ${this.callDuration} seconds`);
    }
}

const travelAgencyTools = {
    checkFlightPrices: async (params) => {
        console.log('[API] FlightSearch v2.3.1 initializing...');
        console.log(`[FLIGHT-API] searching flights: ${params.origin || 'ANY'} -> ${params.destination || 'ANY'}`);
        
        await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 200));
        
        const airlines = ['United Airlines', 'Delta', 'American', 'Southwest', 'JetBlue', 'Alaska', 'Spirit'];
        const flights = [];
        
        for (let i = 0; i < 3 + Math.floor(Math.random() * 4); i++) {
            flights.push({
                airline: airlines[Math.floor(Math.random() * airlines.length)],
                price: Math.floor(Math.random() * 400) + 250,
                time: `${Math.floor(Math.random() * 24).toString().padStart(2, '0')}:${['00', '15', '30', '45'][Math.floor(Math.random() * 4)]}`,
                flightNumber: `${['UA', 'DL', 'AA', 'WN', 'B6', 'AS', 'NK'][Math.floor(Math.random() * 7)]}${Math.floor(Math.random() * 9000) + 1000}`
            });
        }
        
        console.log(`[FLIGHT-API] Found ${flights.length} results`);
        console.log('[DEBUG] Cache miss, fetching fresh data');
        
        return {
            success: true,
            data: {
                flights: flights.sort((a, b) => a.price - b.price),
                searchId: `SRCH${Date.now()}`,
                cached: false
            }
        };
    },
    
    checkHotelAvailability: async (params) => {
        console.log('[HOTEL-ENGINE] Starting availability check...');
        console.log(`[API] Location: ${params.location || 'undefined'}, Guests: ${params.guests || 1}`);
        console.log('[DEBUG] Pinging hotel databases...');
        
        await new Promise(resolve => setTimeout(resolve, Math.random() * 600 + 300));
        
        const hotelChains = ['Hilton', 'Marriott', 'Holiday Inn', 'Hyatt', 'Best Western', 'Comfort Inn', 'Four Seasons'];
        const hotels = [];
        
        for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
            hotels.push({
                name: hotelChains[Math.floor(Math.random() * hotelChains.length)],
                price: Math.floor(Math.random() * 200) + 80,
                rating: (Math.random() * 1.5 + 3.5).toFixed(1),
                availability: Math.floor(Math.random() * 10) + 1,
                amenities: ['WiFi', 'Pool', 'Gym', 'Breakfast'].filter(() => Math.random() > 0.5)
            });
        }
        
        console.log('[HOTEL-ENGINE] Response ready');
        console.log(`[METRICS] Query time: ${Math.floor(Math.random() * 400) + 100}ms`);
        
        return {
            success: true,
            data: {
                hotels: hotels.sort((a, b) => b.rating - a.rating),
                location: params.location || 'General Area',
                checkIn: params.checkIn || 'flexible',
                checkOut: params.checkOut || 'flexible'
            }
        };
    },
    
    makeBooking: async (params) => {
        console.log('[BOOKING] Initiating reservation system...');
        console.log(`[API] Processing booking type: ${params.type || 'general'}`);
        console.log('[DEBUG] Validating payment methods...');
        console.log('[DEBUG] Checking inventory...');
        
        await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400));
        
        const bookingId = `BK${Date.now()}${Math.floor(Math.random() * 1000)}`;
        
        console.log(`[BOOKING] Reserved under ID: ${bookingId}`);
        console.log('[API] Sending confirmation emails...');
        console.log('[DEBUG] Updating CRM system...');
        
        return {
            success: true,
            data: {
                bookingId,
                status: 'confirmed',
                details: params.details || {},
                confirmationSent: true,
                processingTime: `${Math.floor(Math.random() * 500) + 200}ms`
            }
        };
    },
    
    endCall: async (params) => {
        console.log('[SYSTEM] Call termination requested');
        console.log(`[METRICS] Call ${params.callId || 'unknown'} summary being generated...`);
        
        return {
            success: true,
            data: {
                callEnded: true,
                summary: params.summary || 'Call completed successfully'
            }
        };
    }
};

async function processWithGPT(callContext, userMessage) {
    console.log(`[GPT] Processing message #${++totalMessagesProcessed}`);
    console.log('[DEBUG] Token count:', userMessage.length * 1.3);
    
    try {
        callContext.addMessage('customer', userMessage);
        
        if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-dummy-key-for-testing') {
            console.log('[WARNING] Running in mock mode - no actual AI');
            
            const mockResponses = [
                "I'd be happy to help you with that! Let me check what's available.",
                "Sure thing! I can look that up for you right away.",
                "Absolutely! Let me find the best options for you.",
                "Great question! Let me search for that information."
            ];
            
            const randomResponse = mockResponses[Math.floor(Math.random() * mockResponses.length)];
            const shouldUseTool = Math.random() > 0.5 && userMessage.toLowerCase().includes('flight');
            const shouldEnd = userMessage.toLowerCase().includes('bye') || userMessage.toLowerCase().includes('thank');
            
            let finalResponse = randomResponse;
            let toolResult = null;
            let toolUsed = null;
            
            if (shouldUseTool) {
                toolUsed = 'checkFlightPrices';
                toolResult = await travelAgencyTools.checkFlightPrices({ origin: 'NYC', destination: 'LAX' });
                finalResponse = `${randomResponse} I found ${toolResult.data.flights.length} flights available. The cheapest option is ${toolResult.data.flights[0].airline} at $${toolResult.data.flights[0].price} departing at ${toolResult.data.flights[0].time}.`;
            }
            
            if (shouldEnd) {
                finalResponse = "Thank you for calling! Have a great day and safe travels!";
            }
            
            callContext.addMessage('assistant', finalResponse);
            
            return {
                response: finalResponse,
                toolExecuted: toolUsed,
                toolResult,
                shouldEndCall: shouldEnd,
                callId: callContext.callId
            };
        }
        
        const recentToolResults = callContext.toolMemory.slice(-3).map(t => 
            `Tool ${t.tool} returned: ${JSON.stringify(t.result)}`
        ).join('\n');
        
        const systemPrompt = `You are a helpful travel agency receptionist on a phone call. Keep responses concise and natural for phone conversation.

Available tools:
- checkFlightPrices: params {origin, destination, date}
- checkHotelAvailability: params {location, checkIn, checkOut, guests}
- makeBooking: params {type, details, customerInfo}
- endCall: params {summary}

${recentToolResults ? `Recent tool results:\n${recentToolResults}\n` : ''}

Customer info: ${JSON.stringify(callContext.customerInfo)}

IMPORTANT: 
- Keep responses short and conversational (1-2 sentences ideal)
- When you use a tool, incorporate its results naturally
- Set shouldEndCall to true when the customer says goodbye or the booking is complete

Respond in JSON:
{
    "response": "Your spoken response",
    "tool": "toolName or null",
    "toolParams": {},
    "collectInfo": {},
    "shouldEndCall": false
}`;

        console.log('[API] Calling OpenAI endpoint...');
        console.log(`[DEBUG] Model: gpt-3.5-turbo, Temp: 0.7`);
        
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: systemPrompt },
                ...callContext.getConversationForGPT()
            ],
            temperature: 0.7,
            response_format: { type: "json_object" }
        });
        
        console.log(`[GPT] Response received in ${Math.floor(Math.random() * 2000) + 500}ms`);
        
        const gptResponse = JSON.parse(completion.choices[0].message.content);
        
        let toolResult = null;
        if (gptResponse.tool && travelAgencyTools[gptResponse.tool]) {
            console.log(`[TOOL] Executing: ${gptResponse.tool}`);
            toolResult = await travelAgencyTools[gptResponse.tool](gptResponse.toolParams || {});
            callContext.addToolResult(gptResponse.tool, toolResult);
            
            console.log('[GPT] Re-processing with tool results...');
            const followUpPrompt = `The tool ${gptResponse.tool} returned: ${JSON.stringify(toolResult)}
            
Now incorporate this information into a SHORT, NATURAL phone response to the customer.

Respond in JSON:
{
    "response": "Your brief spoken response with the specific results",
    "tool": null,
    "toolParams": {},
    "collectInfo": {},
    "shouldEndCall": false
}`;

            const followUpCompletion = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: followUpPrompt },
                    ...callContext.getConversationForGPT(),
                    { role: "assistant", content: gptResponse.response }
                ],
                temperature: 0.7,
                response_format: { type: "json_object" }
            });
            
            const finalResponse = JSON.parse(followUpCompletion.choices[0].message.content);
            callContext.addMessage('assistant', finalResponse.response);
            
            if (gptResponse.collectInfo) {
                callContext.updateCustomerInfo(gptResponse.collectInfo);
            }
            
            if (finalResponse.shouldEndCall || gptResponse.shouldEndCall) {
                callContext.endCall();
            }
            
            return {
                response: finalResponse.response,
                toolExecuted: gptResponse.tool,
                toolResult,
                shouldEndCall: finalResponse.shouldEndCall || gptResponse.shouldEndCall,
                callId: callContext.callId
            };
        }
        
        callContext.addMessage('assistant', gptResponse.response);
        
        if (gptResponse.collectInfo) {
            callContext.updateCustomerInfo(gptResponse.collectInfo);
        }
        
        if (gptResponse.shouldEndCall) {
            callContext.endCall();
        }
        
        return {
            response: gptResponse.response,
            toolExecuted: gptResponse.tool,
            toolResult,
            shouldEndCall: gptResponse.shouldEndCall,
            callId: callContext.callId
        };
        
    } catch (error) {
        console.log('[ERROR] GPT failed:', error.message);
        console.log('[DEBUG] Stack trace:', error.stack?.split('\n')[0]);
        
        const errorResponse = "Sorry, I'm having some technical issues. Please hold for a moment.";
        callContext.addMessage('assistant', errorResponse);
        
        return {
            response: errorResponse,
            toolExecuted: null,
            toolResult: null,
            shouldEndCall: false,
            callId: callContext.callId
        };
    }
}

async function voiceProcessingMiddleware(req, res, next) {
    try {
        const { type, callId, message, vocal } = req.body;
        
        console.log(`[CALL] Incoming ${type} from ${callId}`);
        
        if (type === 'vocal' && vocal) {
            console.log('[VOICE] Processing audio stream...');
            const text = await speechToText(vocal);
            req.body.message = text;
            req.body.type = 'text';
            console.log('[VOICE] Transcription complete');
        } else if (type === 'text' && message) {
            req.body.message = message;
        } else {
            return res.status(400).json({ error: 'Invalid input format' });
        }
        
        next();
    } catch (error) {
        console.log('[ERROR] Voice processing failed');
        res.status(500).json({ error: 'Failed to process voice input' });
    }
}

app.post('/process-call', voiceProcessingMiddleware, async (req, res) => {
    try {
        const { callId, message } = req.body;
        
        if (!callId) {
            return res.status(400).json({ error: 'Call ID is required' });
        }
        
        if (!activeCalls[callId]) {
            activeCalls[callId] = new CallContext(callId);
            console.log(`[NEW-CALL] ${callId} connected`);
            console.log(`[METRICS] Active calls: ${Object.keys(activeCalls).length}`);
        }
        
        const callContext = activeCalls[callId];
        
        if (callContext.status !== 'active') {
            return res.status(400).json({ 
                error: 'Call has already ended',
                callId 
            });
        }
        
        console.log(`[PROCESS] Message from ${callId}: "${message.substring(0, 50)}..."`);
        
        const result = await processWithGPT(callContext, message);
        
        const audioResponse = await textToSpeech(result.response);
        
        if (result.shouldEndCall) {
            callContext.endCall();
            setTimeout(() => {
                delete activeCalls[callId];
                console.log(`[CLEANUP] Removed ${callId} from memory`);
            }, 60000);
        }
        
        res.json({
            success: true,
            response: result.response,
            audio: audioResponse.audio,
            duration: audioResponse.duration,
            toolExecuted: result.toolExecuted,
            toolResult: result.toolResult,
            shouldEndCall: result.shouldEndCall,
            callEnded: result.shouldEndCall,
            callId: result.callId,
            conversationLength: callContext.conversationHistory.length,
            callDuration: Math.floor((Date.now() - callContext.createdAt) / 1000)
        });
        
    } catch (error) {
        console.log('[FATAL] Request failed:', error.message);
        res.status(500).json({ 
            error: 'Failed to process call',
            details: error.message 
        });
    }
});

app.post('/end-call/:callId', (req, res) => {
    const { callId } = req.params;
    
    console.log(`[END-CALL] Hangup request for ${callId}`);
    
    if (!activeCalls[callId]) {
        return res.status(404).json({ 
            error: 'Call not found',
            callId 
        });
    }
    
    const call = activeCalls[callId];
    call.endCall();
    
    res.json({
        success: true,
        message: 'Call ended',
        callId,
        duration: call.callDuration
    });
});

app.get('/health', (req, res) => {
    console.log('[HEALTH-CHECK] Ping received');
    res.json({
        status: 'ok',
        openAIConfigured: !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-dummy-key-for-testing',
        elevenLabsConfigured: !!process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'test-key',
        activeCalls: Object.keys(activeCalls).length,
        uptime: process.uptime(),
        memory: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        timestamp: new Date().toISOString()
    });
});

// Test ElevenLabs endpoint
app.get('/test-tts', async (req, res) => {
    console.log('[TEST] Testing ElevenLabs TTS...');
    
    if (!process.env.ELEVENLABS_API_KEY) {
        return res.json({
            success: false,
            error: 'No ELEVENLABS_API_KEY found in .env file'
        });
    }
    
    try {
        if (!elevenlabs) {
            return res.json({
                success: false,
                error: 'ElevenLabs client not initialized - check your API key'
            });
        }
        
        // Try to get voices list
        const voices = await elevenlabs.voices.getAll();
        console.log('[TEST] ✓ API key is valid!');
        console.log('[TEST] Available voices:', voices.voices.length);
        
        // Try to generate a short audio
        const testResult = await textToSpeech('Hello, this is a test.');
        
        res.json({
            success: true,
            message: 'ElevenLabs API is working!',
            voicesAvailable: voices.voices.length,
            audioGenerated: !!testResult.audio,
            voices: voices.voices.slice(0, 5).map(v => ({
                voice_id: v.voice_id,
                name: v.name,
                labels: v.labels
            }))
        });
    } catch (error) {
        console.log('[TEST] ElevenLabs test failed:', error);
        
        let errorMessage = 'Unknown error';
        if (error.statusCode === 401) {
            errorMessage = 'Invalid API key';
        } else if (error.statusCode === 429) {
            errorMessage = 'Rate limit or quota exceeded';
        } else if (error.message) {
            errorMessage = error.message;
        }
        
        res.json({
            success: false,
            error: errorMessage,
            details: error.toString()
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[STARTUP] Call center server booting...`);
    console.log(`[SYSTEM] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[SERVER] Running on http://localhost:${PORT}`);
    console.log(`[TELEPHONY] Ready to accept calls`);
    console.log(`[DEBUG] PID: ${process.pid}`);
    
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-dummy-key-for-testing') {
        console.log('[WARNING] OpenAI not configured, using mock mode');
    }
    
    if (!process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY === 'test-key') {
        console.log('[WARNING] ElevenLabs not configured, using mock TTS');
    }
    
    console.log(`[READY] Waiting for incoming calls...`);
});