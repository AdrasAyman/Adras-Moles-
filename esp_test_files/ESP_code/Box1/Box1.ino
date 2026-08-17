#include <WiFi.h>
#include <WiFiUdp.h>

// ================================================================
// CONFIGURATION
// ================================================================
#define BOX_ID 1 

const char* WIFI_SSID = ""; //Enter wifi name
const char* WIFI_PASS = ""; // Eneter password for wifi

// Use IPAddress type directly instead of a text string
const IPAddress PC_IP( );  // Enter you ipV4 address seperated by commas eg 1, 1, 1, 1
const int UDP_PORT = 5000;

WiFiUDP udp;
unsigned long lastSendTime = 0;
const int SEND_INTERVAL_MS = 50;

float getSimulatedDistance(int sensorIndex) {
    float timeVal = (millis() / 1500.0) + (sensorIndex * 2.0) + (BOX_ID * 5.0);
    float baseDistance = 100.0 + (40.0 * sin(timeVal));
    float noise = random(-10, 10) / 10.0; 
    return baseDistance + noise;
}

void setup() {
    Serial.begin(115200);

    Serial.printf("\n[Box %d] Connecting to %s...", BOX_ID, WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    
    Serial.println("\n[Wi-Fi] Connected!");
    Serial.print("[Wi-Fi] Assigned ESP32 IP: ");
    Serial.println(WiFi.localIP());

    // CRITICAL FIX: Initialise local UDP socket binding
    udp.begin(UDP_PORT);
    Serial.printf("[UDP] Listening and sending on port %d\n", UDP_PORT);
}

void loop() {
    if (millis() - lastSendTime >= SEND_INTERVAL_MS) {
        lastSendTime = millis();

        float dist1 = getSimulatedDistance(1);
        float dist2 = getSimulatedDistance(2);

        char payload[64];
        snprintf(payload, sizeof(payload), "Box:%d,S1:%.1f,S2:%.1f", BOX_ID, dist1, dist2);

        // Send over UDP and check return status
        if (udp.beginPacket(PC_IP, UDP_PORT)) {
            udp.print(payload);
            
            if (udp.endPacket() == 1) {
                Serial.printf("[SUCCESS] Sent: %s\n", payload);
            } else {
                Serial.println("[ERROR] Packet failed to transmit over Wi-Fi!");
            }
        } else {
            Serial.println("[ERROR] Failed to open UDP socket to target IP!");
        }
    }
}