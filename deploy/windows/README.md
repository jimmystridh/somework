# Windows machines: cloning

`clone-personalize.ps1` gives a clone of the Windows golden image its own identity. The image itself is not built by a script here:
it is a VM that was set up once and is kept as a never-booted template, from which new machines are cloned (linked clones on ZFS,
created in seconds).

## Why a clone needs personalizing

A clone starts as an exact copy, so it carries the original's computer name, Tailscale node key, SSH host keys and SQL Server
instance name. Two machines with one Tailscale node key take each other off the network, and a `tailscale logout` on a clone
would deregister the original. The script therefore refuses to run while a network link is up.

## Procedure

1. Create the clone from the template and give it its own settings (memory, no auto-start), with the NIC **link down**
   (`net0=...,link_down=1`). Start it. The QEMU guest agent works without a network.
2. Stage 1, through the guest agent (write the script to the guest, then execute it):
   `powershell -NoProfile -ExecutionPolicy Bypass -File clone-personalize.ps1 -NewName <NAME> -Stage 1`
   It forgets the local Tailscale state (service set to manual), regenerates the SSH host keys and renames the computer.
3. Reboot the guest, reconnect the NIC, find its DHCP address through the guest agent, and check that the SSH host key presented on
   the network equals the one the guest generated.
4. Stage 2 (administrator, over SSH or the guest agent):
   `... -NewName <NAME> -Stage 2 -SqlInstance <INSTANCE> -SearchRoots <folders> -RegistryRoots <keys>`
   (the instance is whatever the golden image's SQL Server instance is called; the roots are optional lists of installed-software folders and
   registry keys to scan for the old name)
   It waits for the delayed SQL start, repoints `@@SERVERNAME`, and reports (never rewrites) leftovers that still mention the old name.
5. Per machine, not done by the script: join Tailscale with an auth key if wanted, enroll its own SomeWork agent identity and give it
   its own model login. Licensing is the image's: an evaluation image expires everywhere on the same date.

PowerShell 5.1 notes: no `&&`; write `"${name}:"` instead of `"$name:"` inside strings.
