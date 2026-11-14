---
id: local-model
title: A model on this computer
covers: command:local-model
---

Aman can use a model server that runs on the same computer as Aman, such as Ollama or vLLM. Aman reaches it through its own local link. The link keeps working when this computer's network changes, for example after a software update, and it works with a model server that only listens on this computer.

## Set it up

1. Find the port your model server listens on. Ollama uses 11434 unless you changed it.
2. On the computer where Aman is installed, open a terminal and type `aman local-model 11434`, with your port in place of 11434. With more than one Aman instance, add `--instance` and the instance name.
3. Wait for the message that Aman reaches the model. It shows the address to use, such as `http://aman-local-model:11434/v1`.
   The command also lets Aman use that address, and it starts Aman again so the change takes effect.
4. Open Settings, then Models. Add a custom provider, give it that address, and add your model.

To take the port away again, type `aman local-model 11434 --remove`.

The local link is not available in Aman Setup on Windows yet. There, add a model on this computer in Settings as before, and Aman does not turn its address away.

## If Aman says the address is this computer

When you give a model an address that belongs to this computer, such as its Tailscale name or its home network address, Aman does not save it. Such an address can stop answering Aman after a network change on this computer, and the model would stop working without warning. Do the steps above and use the address Aman shows instead.

## If Aman says the local link does not carry a port

Aman only uses the local link at the ports you added. Type `aman local-model` with that port on the computer where Aman is installed, then save the model again.

## If Aman could not connect to the model

The message says where the model is. When it says nothing answered on this computer, start the model server, then send your message again. When it says this computer did not accept the connection at an address, open Settings, then Models, and save the model again. Aman then offers its local link.
