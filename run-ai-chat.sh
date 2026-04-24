#!/bin/bash

# Run Glon AI Chat Demo
# This script interacts with the Glon client to create and chat with an AI agent

cd /Users/grantfarwell/Projekt/3/Glon

# Use expect to interact with the client
expect << 'EOF'
spawn npm run client

# Wait for the prompt
expect "glon>"

# Create the agent
send "/agent new GlonAI\r"
expect "glon>"
sleep 1

# Configure the model
send "/agent config GlonAI model claude-3-5-haiku\r"
expect "glon>"
sleep 1

# Set system prompt
send "/agent config GlonAI system You are an AI assistant running inside Glon OS, a revolutionary content-addressed DAG-based operating system where everything is a program! Be friendly and helpful!\r"
expect "glon>"
sleep 1

# Ask a question
send "/agent ask GlonAI Hello! Can you tell me about yourself and the system you're running on? What makes Glon OS special?\r"
expect -timeout 20 "glon>"
sleep 2

# Show history
send "/agent history GlonAI\r"
expect "glon>"
sleep 1

# Exit
send "exit\r"
expect eof
EOF

echo ""
echo "AI Chat demo complete!"