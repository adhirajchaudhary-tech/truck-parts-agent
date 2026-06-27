#!/bin/bash

# Create .env file from Railway environment variables
cat > /app/.env << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}
TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}
TWILIO_WHATSAPP_NUMBER=${TWILIO_WHATSAPP_NUMBER}
EOF

# Run the app
node initDb.js && node setupDatabase.js && node server.js