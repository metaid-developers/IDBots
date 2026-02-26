#!/usr/bin/env python3
"""
Monitor file upload task progress.

Usage:
    python monitor_task.py <task_id> [timeout] [interval]
    
Arguments:
    task_id: Task ID returned from chunked upload
    timeout: Maximum time to wait in seconds (default: 300)
    interval: Polling interval in seconds (default: 5)
    
Example:
    python monitor_task.py abc123def456 300 5
"""

import requests
import time
import sys
import json


# API Configuration
API_BASE = "https://file.metaid.io/metafile-uploader"
DEFAULT_TIMEOUT = 300  # 5 minutes
DEFAULT_INTERVAL = 5   # 5 seconds


def monitor_task(task_id, timeout=DEFAULT_TIMEOUT, interval=DEFAULT_INTERVAL):
    """
    Monitor task status until completion or failure.
    
    Args:
        task_id: Task ID to monitor
        timeout: Maximum time to wait (seconds)
        interval: Polling interval (seconds)
        
    Returns:
        Task data if successful, None if failed or timeout
    """
    start_time = time.time()
    attempt = 0
    
    print(f"🔍 Monitoring task: {task_id}", file=sys.stderr)
    print(f"⏰ Timeout: {timeout}s | Interval: {interval}s\n", file=sys.stderr)
    
    while time.time() - start_time < timeout:
        attempt += 1
        elapsed = int(time.time() - start_time)
        
        try:
            # Query task status
            url = f"{API_BASE}/api/v1/files/task/{task_id}"
            response = requests.get(url, timeout=10)
            result = response.json()
            
            if result.get('code') != 0:
                error_msg = result.get('message', 'Unknown error')
                print(f"\n❌ API Error: {error_msg}", file=sys.stderr)
                return None
            
            task = result.get('data', {})
            status = task.get('status', 'unknown')
            progress = task.get('progress', 0)
            stage = task.get('stage', 'unknown')
            message = task.get('message', '')
            
            # Display progress
            progress_bar = create_progress_bar(progress)
            print(f"\r[{elapsed}s] {progress_bar} {progress}% | {status} | {stage}", 
                  end='', file=sys.stderr)
            
            # Check terminal states (API returns snake_case: index_tx_id, chunk_tx_ids)
            if status == 'success':
                index_tx_id = task.get('index_tx_id') or task.get('indexTxId') or 'N/A'
                pin_id = f"{index_tx_id}i0" if index_tx_id and index_tx_id != 'N/A' else 'N/A'
                print(f"\n\n✅ Upload completed successfully!", file=sys.stderr)
                print(f"📦 Index TxID: {index_tx_id}", file=sys.stderr)
                print(f"📌 PinID: {pin_id}", file=sys.stderr)
                chunk_ids = task.get('chunk_tx_ids') or task.get('chunkTxIds')
                if chunk_ids:
                    if isinstance(chunk_ids, str):
                        try:
                            chunk_ids = json.loads(chunk_ids)
                        except (json.JSONDecodeError, TypeError):
                            chunk_ids = []
                    if isinstance(chunk_ids, list):
                        print(f"🧩 Chunk transactions: {len(chunk_ids)}", file=sys.stderr)
                return task
            
            elif status == 'failed':
                print(f"\n\n❌ Upload failed: {message or 'Unknown error'}", file=sys.stderr)
                return None
            
            # Wait before next poll
            time.sleep(interval)
            
        except requests.exceptions.Timeout:
            print(f"\n⚠️  Request timeout, retrying...", file=sys.stderr)
            time.sleep(interval)
            
        except requests.exceptions.RequestException as e:
            print(f"\n⚠️  Network error: {e}", file=sys.stderr)
            time.sleep(interval)
            
        except Exception as e:
            print(f"\n❌ Unexpected error: {e}", file=sys.stderr)
            time.sleep(interval)
    
    # Timeout reached
    print(f"\n\n⏰ Timeout after {timeout} seconds", file=sys.stderr)
    print(f"Task may still be processing. Check status manually with:", file=sys.stderr)
    print(f"  curl {API_BASE}/api/v1/files/task/{task_id}", file=sys.stderr)
    return None


def create_progress_bar(progress, width=20):
    """Create a text-based progress bar."""
    filled = int(width * progress / 100)
    bar = '█' * filled + '░' * (width - filled)
    return f"[{bar}]"


def format_task_result(task):
    """Format task result as structured JSON (camelCase for shell/jq). API uses snake_case."""
    if not task:
        return None
    index_tx_id = task.get('index_tx_id') or task.get('indexTxId')
    pin_id = f"{index_tx_id}i0" if index_tx_id else None
    chunk_tx_ids = task.get('chunk_tx_ids') or task.get('chunkTxIds')
    if isinstance(chunk_tx_ids, str):
        try:
            chunk_tx_ids = json.loads(chunk_tx_ids)
        except (json.JSONDecodeError, TypeError):
            chunk_tx_ids = []
    if not isinstance(chunk_tx_ids, list):
        chunk_tx_ids = []
    indexer_base = "https://file.metaid.io/metafile-indexer"
    result = {
        "success": True,
        "taskId": task.get('task_id') or task.get('taskId'),
        "status": task.get('status'),
        "indexTxId": index_tx_id,
        "pinId": pin_id,
        "chunkTxIds": chunk_tx_ids,
        "chunkCount": len(chunk_tx_ids),
        "viewUrls": {
            "transaction": f"https://www.mvcscan.com/tx/{index_tx_id}" if index_tx_id else None,
            "pin": f"https://man.metaid.io/pin/{pin_id}" if pin_id else None,
            "content": f"{indexer_base}/api/v1/files/content/{pin_id}" if pin_id else None,
            "accelerate": f"{indexer_base}/api/v1/files/accelerate/content/{pin_id}" if pin_id else None,
        }
    }
    return result


def main():
    if len(sys.argv) < 2:
        print("Error: Task ID required", file=sys.stderr)
        print("\nUsage: python monitor_task.py <task_id> [timeout] [interval]", file=sys.stderr)
        print("\nArguments:", file=sys.stderr)
        print("  task_id   - Task ID (required)", file=sys.stderr)
        print("  timeout   - Max wait time in seconds (default: 300)", file=sys.stderr)
        print("  interval  - Polling interval in seconds (default: 5)", file=sys.stderr)
        print("\nExample:", file=sys.stderr)
        print("  python monitor_task.py abc123def456 300 5", file=sys.stderr)
        sys.exit(1)
    
    task_id = sys.argv[1].strip()
    timeout = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_TIMEOUT
    interval = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_INTERVAL
    
    # Validate parameters
    if not task_id:
        print("Error: Task ID cannot be empty", file=sys.stderr)
        sys.exit(1)
    
    if timeout <= 0:
        print("Error: Timeout must be positive", file=sys.stderr)
        sys.exit(1)
    
    if interval <= 0 or interval > timeout:
        print("Error: Invalid interval", file=sys.stderr)
        sys.exit(1)
    
    # Monitor task
    task_result = monitor_task(task_id, timeout, interval)
    
    # Format and output result: single-line JSON to stdout for shell/jq parsing; progress goes to stderr
    if task_result:
        formatted_result = format_task_result(task_result)
        print(json.dumps(formatted_result, separators=(',', ':')))
        sys.exit(0)
    else:
        error_result = {
            "success": False,
            "error": "Task monitoring failed or timeout",
            "taskId": task_id
        }
        print(json.dumps(error_result, separators=(',', ':')))
        sys.exit(1)


if __name__ == '__main__':
    main()
