# TTS Persist (UI Extension) - Permanent Audio Storage for SillyTavern

Tired of losing your beautifully generated TTS audio every time you refresh the page, switch characters, or open SillyTavern on your phone? 

**TTS Persist** solves this by fundamentally changing how SillyTavern handles text-to-speech. Instead of ephemeral audio that vanishes, TTS Persist **permanently saves your generated audio files directly to your server's hard drive.**

⚠️ **CRITICAL REQUIREMENT:** This UI extension will **NOT WORK** unless you also install the Server Plugin to handle the file saving. 
**Get the Server Plugin here:** [https://github.com/DBMePls/sillytavern-tts-persist-server](https://github.com/DBMePls/sillytavern-tts-persist-server)

## 🌟 Key Features

* 💾 **Permanent Audio Storage:** Once a message is narrated, the audio file is permanently saved to your server. Refresh the page, restart your PC, or come back a month later—your audio is exactly where you left it.
* 📱 **True Cross-Device Playback:** Generate the audio using your powerful desktop GPU, then open SillyTavern on your phone in bed and instantly play the saved audio without having to regenerate a thing.
* ⏭️ **Swipe Memory:** Generates and saves unique audio files for every individual message swipe. Swap back to an old swipe, and its specific audio will load instantly.
* ⚡ **Background Generation Queue:** Don't wait around for long audio files to generate. TTS Persist queues up upcoming messages and processes them silently in the background while you continue chatting.
* 🗣️ **Advanced Voice Routing:** Easily assign completely different voices for character dialogue ("quotes"), character actions (*asterisks*), and general narration. 

## Installation (Part 1: UI)

This extension is installed directly inside the SillyTavern browser interface.

1. Open SillyTavern in your web browser.
2. Open the **Extensions** panel (the stacked cubes icon <i class="fa-solid fa-cubes"></i> at the top of the screen).
3. Click on **Download Extensions & Assets**.
4. Click the **Install Extension** button (the cloud icon with a down arrow <i class="fa-solid fa-cloud-arrow-down"></i>).
5. Paste this repository URL into the box:
   `https://github.com/DBMePls/sillytavern-tts-persist-ui`
6. Click **Save** or **Install**. SillyTavern will download the extension and refresh the page.

## Installation (Part 2: Server Plugin)

To actually store the audio files, your SillyTavern backend needs permission to write them to your hard drive. 

Please head over to the [sillytavern-tts-persist-server repository](https://github.com/DBMePls/sillytavern-tts-persist-server) and follow the quick installation instructions there to finish your setup!