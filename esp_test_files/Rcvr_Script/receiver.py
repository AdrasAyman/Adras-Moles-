import socket

# Configuration
UDP_IP = "0.0.0.0"  # Listen on all available network adapters (Wi-Fi/Hotspot)
UDP_PORT = 5000     # Must match the UDP_PORT set in your ESP32 code

# Create UDP socket
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((UDP_IP, UDP_PORT))

print(f"=== UDP Receiver Running on Port {UDP_PORT} ===")
print("Waiting for ESP32 streams...\n")

# Dictionary to hold the latest live readings from both physical boxes
latest_sensor_data = {
    1: {"S1": 0.0, "S2": 0.0},
    2: {"S1": 0.0, "S2": 0.0}
}

try:
    while True:
        # 1. Catch incoming UDP packet from an ESP32
        data, addr = sock.recvfrom(1024)
        payload = data.decode('utf-8').strip() # e.g., "Box:1,S1:120.5,S2:115.2"
        
        try:
            # 2. Parse the string into usable numbers
            parts = payload.split(',')
            box_id = int(parts[0].split(':')[1])
            s1_val = float(parts[1].split(':')[1])
            s2_val = float(parts[2].split(':')[1])
            
            # 3. Store the numbers under the corresponding Box ID
            if box_id in latest_sensor_data:
                latest_sensor_data[box_id]["S1"] = s1_val
                latest_sensor_data[box_id]["S2"] = s2_val
            
            # 4. Display live updating readings for both boxes in terminal
            b1 = latest_sensor_data[1]
            b2 = latest_sensor_data[2]
            print(f"[LIVE] Box 1 -> S1: {b1['S1']:5.1f}cm | S2: {b1['S2']:5.1f}cm   ||   Box 2 -> S1: {b2['S1']:5.1f}cm | S2: {b2['S2']:5.1f}cm", end="\r")

        except (IndexError, ValueError):
            print(f"\nWarning: Received unformatted packet -> {payload}")

except KeyboardInterrupt:
    print("\nReceiver stopped by user.")
finally:
    sock.close()