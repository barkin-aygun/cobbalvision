#!/bin/bash
set -e

if [ ! -f .deploy ]; then
  echo "Error: .deploy file not found. Create it with SFTP_HOST, SFTP_PORT, and SFTP_PATH."
  exit 1
fi

source .deploy

echo "Deploying to ${SFTP_HOST}:${SFTP_PORT}..."
read -sp "Password: " PASSWORD
echo

sftp -P "$SFTP_PORT" -oBatchMode=no "$SFTP_USER@$SFTP_HOST" <<EOF
cd $SFTP_PATH
put index.js
put package.json
put .env
put .gitignore
bye
EOF

echo "Deploy complete!"
