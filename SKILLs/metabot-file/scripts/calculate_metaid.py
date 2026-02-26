#!/usr/bin/env python3
"""
Calculate MetaID from MVC address.
MetaID = SHA256(address)

Usage:
    python calculate_metaid.py <address>
    
Example:
    python calculate_metaid.py 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
"""

import hashlib
import sys
import json


def calculate_metaid(address):
    """
    Calculate MetaID using SHA256 hash of the address.
    
    Args:
        address: MVC blockchain address
        
    Returns:
        MetaID as hex string
    """
    metaid = hashlib.sha256(address.encode('utf-8')).hexdigest()
    return metaid


def main():
    if len(sys.argv) < 2:
        print("Error: Address required", file=sys.stderr)
        print("\nUsage: python calculate_metaid.py <address>", file=sys.stderr)
        print("\nExample:", file=sys.stderr)
        print("  python calculate_metaid.py 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", file=sys.stderr)
        sys.exit(1)
    
    address = sys.argv[1].strip()
    
    if not address:
        print("Error: Address cannot be empty", file=sys.stderr)
        sys.exit(1)
    
    metaid = calculate_metaid(address)
    
    # Output as JSON for easy parsing
    result = {
        "address": address,
        "metaId": metaid
    }
    
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
