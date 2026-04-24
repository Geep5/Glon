#!/bin/bash

# Chat with the Glon AI agent

cd /Users/grantfarwell/Projekt/3/Glon

expect << 'EOF'
spawn npm run client

# Wait for the prompt
expect "glon>"
sleep 1

# Ask the agent a question using its ID
send "/agent ask 0957 Hello! Can you tell me about yourself and the system you're running on? What makes Glon OS special?\r"
expect -timeout 30 "glon>"
sleep 1

# Ask another question
send "/agent ask 0957 How does the content-addressed DAG work in Glon OS?\r"
expect -timeout 30 "glon>"
sleep 1

# Show history
send "/agent history 0957\r"
expect -timeout 10 "glon>"
sleep 1

# Exit
send "exit\r"
expect eof
EOF

echo ""
echo "Chat complete!"