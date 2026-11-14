---
id: local-model
title: A model on this computer
covers: command:local-model
---

Aman can use a model server that runs on the same computer as Aman, such as Ollama or vLLM. In Settings, then Models, add a custom provider and give it the model's address. For the address, type `http://` followed by `host.docker.internal:11434/v1`, with your port in place of 11434. The computer's home network address or Tailscale address works too.

## The local link

Aman also has its own local link to a model on this computer. You do not need it. It helps in two cases:

- Your model server only listens on this computer, so Aman cannot reach it at any other address. Ollama does this unless you change it.
- You want the model to keep working when this computer's network changes, for example after a software update.

To set it up:

1. Find the port your model server listens on. Ollama uses 11434 unless you changed it.
2. On the computer where Aman is installed, open a terminal and run this, with your port in place of 11434. With more than one Aman instance, add `--instance` and the instance name.

   ```bash
   aman local-model 11434
   ```

3. Wait for the message that Aman reaches the model. It shows the address to use, such as `http://aman-local-model:11434/v1`.
   The command also lets Aman use that address, and it starts Aman again so the change takes effect.
4. Open Settings, then Models. Give the model that address.

To take the port away again, run:

```bash
aman local-model 11434 --remove
```

The local link is not available in Aman Setup on Windows yet. There, use the `host.docker.internal` address above.

## If Aman says the local link does not carry a port

Aman only uses the local link at the ports you added. Type `aman local-model` with that port on the computer where Aman is installed, then save the model again.

## If Aman could not connect to the model

When the message says nothing answered on this computer, start the model server, then send your message again. When it names an address, check that the model server is running. If the model is on this computer and it stopped answering after a network change, the local link above is a way that keeps working.
