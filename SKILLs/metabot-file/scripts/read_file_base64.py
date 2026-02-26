#!/usr/bin/env python3
"""
Read file and convert to base64 encoding.

Usage:
    python read_file_base64.py <file_path>
    
Example:
    python read_file_base64.py res/file/image.png
"""

import base64
import sys
import os
import json
import mimetypes


# 5MB threshold for upload method selection
UPLOAD_THRESHOLD_MB = 5
UPLOAD_THRESHOLD_BYTES = UPLOAD_THRESHOLD_MB * 1024 * 1024  # 5,242,880 bytes


def get_file_info(file_path):
    """
    Get detailed information about a file.
    
    Args:
        file_path: Path to the file
        
    Returns:
        Dictionary with file information
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    
    file_size = os.path.getsize(file_path)
    file_name = os.path.basename(file_path)
    
    # Detect MIME type
    mime_type, _ = mimetypes.guess_type(file_path)
    if not mime_type:
        mime_type = 'application/octet-stream'
    
    # Determine if it's a text type
    is_text_type = (
        mime_type.startswith('text/') or
        mime_type in ['application/json', 'application/javascript', 'application/xml']
    )
    
    # Build contentType (add ;binary suffix for non-text types)
    content_type = mime_type
    if not is_text_type and ';binary' not in content_type:
        content_type = content_type + ';binary'
    
    # Determine recommended upload method
    upload_method = 'direct' if file_size <= UPLOAD_THRESHOLD_BYTES else 'chunked'
    
    return {
        'fileName': file_name,
        'filePath': file_path,
        'fileSize': file_size,
        'fileSizeMB': round(file_size / (1024 * 1024), 2),
        'mimeType': mime_type,
        'contentType': content_type,
        'uploadMethod': upload_method,
        'uploadThresholdMB': UPLOAD_THRESHOLD_MB
    }


def read_file_as_base64(file_path):
    """
    Read file and convert to base64 encoding.
    
    Args:
        file_path: Path to the file
        
    Returns:
        Dictionary with file info and base64 content
    """
    file_info = get_file_info(file_path)
    
    # Read file content
    with open(file_path, 'rb') as f:
        file_content = f.read()
    
    # Convert to base64
    base64_content = base64.b64encode(file_content).decode('utf-8')
    
    result = {
        **file_info,
        'base64Content': base64_content,
        'base64Length': len(base64_content)
    }
    
    return result


def main():
    if len(sys.argv) < 2:
        print("Error: File path required", file=sys.stderr)
        print("\nUsage: python read_file_base64.py <file_path>", file=sys.stderr)
        print("\nExample:", file=sys.stderr)
        print("  python read_file_base64.py res/file/image.png", file=sys.stderr)
        sys.exit(1)
    
    file_path = sys.argv[1].strip()
    
    try:
        result = read_file_as_base64(file_path)
        
        # Print result as JSON
        print(json.dumps(result, indent=2))
        
        # Print summary to stderr for user visibility
        print(f"\n✅ File read successfully", file=sys.stderr)
        print(f"📁 File: {result['fileName']}", file=sys.stderr)
        print(f"📊 Size: {result['fileSizeMB']} MB ({result['fileSize']:,} bytes)", file=sys.stderr)
        print(f"📄 Type: {result['contentType']}", file=sys.stderr)
        print(f"🚀 Recommended method: {result['uploadMethod']} upload", file=sys.stderr)
        
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error reading file: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
