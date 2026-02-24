#!/bin/bash
# Environment check script for metabot-basic
# Verifies Node.js >= 18.x.x and TypeScript installation

set -e

echo "🔍 Checking environment prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed"
    echo "   Please install Node.js >= 18.x.x from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Error: Node.js version must be >= 18.x.x"
    echo "   Current version: $(node -v)"
    echo "   Please upgrade Node.js from https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"

# Check TypeScript
if ! command -v tsc &> /dev/null && ! command -v ts-node &> /dev/null; then
    echo "❌ Error: TypeScript is not installed"
    echo "   Install globally: npm install -g typescript ts-node"
    echo "   Or install locally: npm install --save-dev typescript ts-node"
    exit 1
fi

if command -v tsc &> /dev/null; then
    echo "✅ TypeScript version: $(tsc -v)"
elif command -v ts-node &> /dev/null; then
    echo "✅ ts-node is available"
fi

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed"
    exit 1
fi

echo "✅ npm version: $(npm -v)"
echo ""
echo "✅ Environment check passed!"
