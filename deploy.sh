#!/bin/bash
set -e

if [ ! -f .deploy ]; then
  echo "Error: .deploy file not found. Create it with SFTP_HOST, SFTP_PORT, and SFTP_PATH."
  exit 1
fi

source .deploy

echo "Deploying to ${SFTP_HOST}:${SFTP_PORT}..."
read -p "Username: " USERNAME
read -sp "Password: " PASSWORD
echo

sftp -P "$SFTP_PORT" -oBatchMode=no "$USERNAME@$SFTP_HOST" <<EOF
cd $SFTP_PATH
put index.js
put package.json
put .env
bye
EOF

echo "Deploy complete!"
