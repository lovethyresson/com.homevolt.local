# Homevolt local console — full `help` capture

Primary-source reference for the local console API described in [../CLAUDE.md](../CLAUDE.md).

| | |
|---|---|
| **Source** | `tibber-bridge>` / `ecu-hub-esp32>` prompt on a real unit |
| **Transport** | `POST http://<ip>/console.json`, form field `cmd` |
| **Captured** | 2026-08-11 |
| **Command** | `help` |

There is no public specification for this API — it is unsanctioned and reverse-engineered (see
[../README.md](../README.md)), and Homevolt can change or remove any of it in a firmware update
without notice. This file is therefore kept **verbatim and unedited**, so that a future capture from
a newer firmware can be diffed against it directly. Curated notes, app-specific interpretation and
the meaning of the values live in [../CLAUDE.md](../CLAUDE.md) — not here.

Most of the commands below are ESP32 system/diagnostic commands (wifi, LTE, OTA, coredump, heap
tracing, Modbus, …) that this app does not use. The ones that matter to the app are `sched_add`,
`sched_set`, `sched_clear`, `sched_del`, `sched_list`, `param_get`, `param_set`, `param_list`,
`param_store`, `ems` and `energy`.

Two commands this app sent historically do **not** appear anywhere in this output, and were fixed
after this capture:

- `sched_add … --cond_type=1` — `sched_add` has no `--cond_type` option.
- `param_dump` — does not exist; the equivalent is `param_list`.

---

```text
tibber-bridge> help
ecu-hub-esp32>  help
ap_clients 
  Print a list of clients connected to soft-AP

burnin_set  <qr_code> <test_info> <mfg_date> <provreg_url> <provreg_auth> <burnin_lock>
  Set factory burnin.
     <qr_code>  
   <test_info>  
    <mfg_date>  
  <provreg_url>  
  <provreg_auth>  
  <burnin_lock>  

cat  <path> [<data>]
  cat file
        <path>  File to cat
        <data>  if data is included file is created

clear 
  Clear the screen

coredump_crash 
  Crash the esp32

coredump_erase 
  Erase cordump partition

coredump_upload  [-e] [url] [filename]
  Upload core dump to server
           url  Url to send to
      filename  Filename
   -e, --erase  Erase after successful upload

curl  <url> [-o <string>] [-a <attempts>] [-t <timeout>]
  Make http requests.
         <url>  Url to download file from
  -o, --output=<string>  Path to save file to
  -a, --attempts=<attempts>  Number of attempts
  -t, --timeout=<timeout>  Timeout in seconds

debug_led_set  <index> <value>
  Set pwm value for debug led
       <index>  Index of debug led to set
       <value>  Value to set debug led to (0.0 - 1.0)

dmesg  [-cps] [-l <limit>]
  Print log buffer
   -c, --clear  Clear buffer on receive
   -p, --purge  Purge buffer without printing
   -s, --stats  Print log buffer stats
  -l, --limit=<limit>  Maximum count of entries to fetch at a time, -1 for unlimited

echo 
  Print a string

ecu_ctx_reset  
  Reset ECU context

ecu_ffr_rearm  
  Rearm FFR immediately if in standby

ecu_network  
  Show secure transport status

ecu_network_reset  
  Reinitialize secure transport

ecu_sense_assign  <euid> [-i <string>]... <function> [-l <label>]
  Assign a sensor node to a function
        <euid>  Sensor node EUID (hex format, e.g., 0x123456789ABCDEF0)
  -i, --interface=<string>  Clamp interface bitmask (0-7 or L1, L2, L3)
    <function>  Sensor function: 'grid' or 'solar'
  -l, --label=<label>  Optional label for the assignment (max 20 chars)

ecu_sense_clear  [<euid>] [-i <string>]...
  Clear sensor assignments (all or specific node)
        <euid>  Sensor node EUID (hex format) - optional, clears all if omitted
  -i, --interface=<string>  Clamp interface bitmask (0-7 or L1, L2, L3)

ecu_sense_list 
  List all sensor assignments

efr  [--uart] [--power] [--start] [--stop]
  Start, stop or reset efr
        --uart  Restart uart
       --power  Restart power
       --start  Start uart
        --stop  Stop uart

efr_cli 
  Send a command to efr_cli

efr_factory_reset 
  Factory reset efr chip.

efr_flash  <file> <baudrate>
  Flash efr chip
        <file>  File to flash
    <baudrate>  Baudrate to flash

ems  
  Show ems information

ems_cli 
  Run cli client command

ems_config_set  
  Set ems config
  -g, --grid_code=<grid_code>  Grid code
  -t, --control_timeout=<control_timeout>  Control timeout in seconds. 0 = disabled

ems_freq_report_test  
  Enable test mode for EMS frequency report server.

ems_reset  
  Reset EMS HW

energy  [-s] [-n <name>] [-i <kWh>] [-e <kWh>]
  List or modify energy counters
  -n, --name=<name>  Energy aggregate name to modify
  -i, --imported=<kWh>  Set imported energy in kWh
  -e, --exported=<kWh>  Set exported energy in kWh
   -s, --store  Store values to flash immediately

factory_reset  [-n]
  Factory reset all the parameters
  -n, --no-restart  Do not restart after factory reset

format 
  Format the filesystem

free 
  shot spi disk usage

heap_trace_dump  [--internal] [--spiram]
  Dump heap trace
    --internal  Dump internal heap trace
      --spiram  Dump SPIRAM heap trace

heap_trace_start  [--leaks] [--min_size=<n>]
  Start heap trace
       --leaks  Trace heap leaks only
  --min_size=<n>  Minimum size of allocation to trace

heap_trace_stop 
  Stop heap trace

help  [<string>] [-v <0|1>]
  Print the summary of all registered commands if no arguments are given,
  otherwise print summary of given command.
      <string>  Name of command
  -v, --verbose=<0|1>  If specified, list console commands with given verbose level

history 
  Print command history

hmi  [mode|bri|soc|dir|col] <x> {<y>}, <x> = ? for help
  Set led strip mode and parameters

info 
  Get info of chip and SDK

inverter_config_set  
  Set inverter config
  -f, --fstart_freq=<custom_ffr_fstart_freq>  Custom FFR Fstart frequency

log_list  [<search>]
  Set log level
      <search>  Search for log tag name

log_mqtt  <interval_ms> <duration_s>
  Stream logs via mqtt
  <interval_ms>  Log interval (0 will stop current timer)
  <duration_s>  Log timeout (0 will never stop)

log_reset  [<level>]
  Reset all log to loglevel
       <level>  Log level, 0 - None, 1 - Error, 2 - Warn, 3 - Info, 4 - Debug, 5 - Verbose

log_set  [<name>] [<level>]
  Set log level
        <name>  Log tag name
       <level>  Log level, 0 - None, 1 - Error, 2 - Warn, 3 - Info, 4 - Debug, 5 - Verbose

ls  <path>
  list files
        <path>  Path to list files in

lte_at  <command> [<timeout>]
  Send an AT command to LTE modem
     <command>  AT command
     <timeout>  Timeout in ms

lte_band  <band>
  Change network band
        <band>  SIM type ALL(a) 2G/4G(s) 2G(2) 4G(4) NB-IoT(i)

lte_clear_sim 
  Clear SIM

lte_connect 
  Connect LTE modem

lte_disconnect 
  Disconnect LTE modem

lte_info 
  Show LTE modem info

lte_power  <power>
  Control LTE modem power
       <power>  Power ON(1) OFF(0)

lte_restart 
  Restart LTE modem

lte_sim_iccid 
  Get SIM ICCID

lte_sim_type  <sim_type>
  Change SIM type
    <sim_type>  SIM type CARD(0) CHIP(1)

mem  [-thfdea]
  Get the current size of free heap memory
   -t, --tasks  Dump task memory information
    -h, --heap  Dump heap memory information
    -f, --full  Dump full heap memory information
    -d, --dump  Dump heap memory information
   -e, --dumpe  Dump heap memory information
     -a, --all  Dump all memory information

metrics_send  
  Force sending metrics

modbus_read  <slave> <addr> <format>
  Read Modbus register
  modbus_read <slave> <addr> <format = u16/s16/u32/s32/length(#16-bit
  registers)>

modbus_write  <slave> <addr> <format> <data>
  Write Modbus register
  modbus_write <slave> <addr> <format = u16/s16/u32/s32/str> <data>

mqtt 
  Get mqtt status

mqtt_force_connect 
  Force mqtt to connect

net  <ping/set_netif/enable/disable> [<sta/lte/ap/ems>] [<ip>]
  Network control
  <ping/set_netif/enable/disable>  command
  <sta/lte/ap/ems>  module
          <ip>  remote ip address

network  [<interface>]
  Get network status
   <interface>  interface

node_cli 
  Send a command to efr_cli <node_id> cmd1 cmd2 cmd3 ...

node_data  [-xc] [<node_id>]
  Print data from a node
     <node_id>  Node to start flashing from manifest
     -x, --hex  hex display
  -c, --canonical  canonical hex+ASCII display

node_metrics  [<node_id>]
  Print node metrics
     <node_id>  Node id

node_ota_abort  <node_id>
  Send image to node
     <node_id>  Node to abort flashing

node_ota_distribute  <node_id>
  Start distributing image from manifest
     <node_id>  Node to start flashing from manifest

node_ota_distribute_file  <node_id> <filename> <file_size> <image_tag>
  Send distributing image from file
     <node_id>  Node to start flashing
    <filename>  file to flash
   <file_size>  Filesize
   <image_tag>  ota-tag to use

node_param_send  <node_id> <key> <value> [<value>]...
  Send parameter to node
     <node_id>  Id of node, see nodes
         <key>  parameter key (numeric)
       <value>  value to send

node_params  <node_id>
  Get list of parameters from node
     <node_id>  Id of node, see nodes

node_ping 
  Send a ping to node <node_id> <encrypted 1/0>

nodes 
  Get list of connected nodes

ota_clean 
  Run ota cleanup.

ota_esp32  <rollback|validate>
  Rollback/validate/invalidate ESP32 OTA image
  <rollback|validate>  Action to perform: 'rollback' to switch to previous image, 'validate' to mark current image as valid.

ota_esp32_flash  <ota_url>
  Flash ota file from source.
     <ota_url>  Url to flash

ota_fetch 
  Fetch manifest now.

ota_fetch_force 
  Force manifest fetch (version=0.0)

ota_manifest 
  Show manifest.

ota_manifest_set  <model> <version> <url> <size> <checksum> <product_id> <ota_tag>
  Flash ota file from source.
       <model>  Model to flash
     <version>  Version to flash
         <url>  Url to flash
        <size>  Filesize of file to flash
    <checksum>  Checksum to flash
  <product_id>  product_id
     <ota_tag>  ota_tag

ota_run  <model>
  Run ota upgrade.
       <model>  Model to run

param_get  <key>
  Get param value.
         <key>  key of the value to be read

param_list  [-dn]
  List params
  -d, --defaults  Show default values
  -n, --non-defaults  Show non-default values only

param_load  [<storage>]
  Load all param changes from flash
     <storage>  storage to load from

param_reset  [<param_id>]
  Reset param to default values
    <param_id>  id of the parameter to be reset

param_set  [-fc] <key> <value> [<value>]...
  Set key-value pair in selected namespace.
         <key>  key of the value to be set
       <value>  value to be stored
   -f, --force  Force set even if validation fails
  -c, --commit  Commit changes to flash storage immediately

param_store  [-c] [<param_id>] [<storage>]
  Store all param changes to flash
    <param_id>  id of the parameter to be stored
     <storage>  storage to save to
   -c, --clean  Clean the storage if the values contains default values

ping  [-b46] [-W <t>] [-i <t>] [-s <n>] [-c <n>] [-Q <n>] [-T <n>] <host>
  send ICMP ECHO_REQUEST to network hosts
  -W, --timeout=<t>  Time to wait for a response, in seconds
  -i, --interval=<t>  Wait interval seconds between sending each packet
  -s, --size=<n>  Specify the number of data bytes to be sent
  -c, --count=<n>  Stop after sending count packets
  -Q, --tos=<n>  Set Type of Service related bits in IP datagrams
  -T, --ttl=<n>  Set Time to Live related bits in IP datagrams
        <host>  Host address
  -b, --background  Run ping in the background
    -4, --ipv4  Force using IPv4
    -6, --ipv6  Force using IPv6

power  [i|c|s] {<x>}
  Show (i) or clear (c) power state info. Set supercap charge (s <0|1>)

provision  [<url>] [<auth>] [--no-device]
  provision bridge
         <url>  Provisioning URL
        <auth>  Provisioning http auth
   --no-device  Do not use device cert to provision

pulse_monitor_status 
  Show pulse monitor status and timestamps

read_mem  [-bxcd] memory_offset size
  Read memory
  memory_offset  Memory offset
          size  Size of memory to read
     -b, --bin  Read memory as binary
     -x, --hex  Read memory as hex
     -c, --chr  Read memory as char
     -d, --dec  Read memory as dec

reset  [<reset_delay_ms>]
  Software reboot of the chip
  <reset_delay_ms>  Delay in milliseconds before rebooting the system, 0 to abort reboot

reset_hard 
  Reset the device by pulling HMI_BTN1 high, and wait for hardware to reset

rm  <path>
  rm file
        <path>  Path to remove

sched_add  [-maeo] <type> [--from=<from>] [--to=<to>] [--min=<min>] [--max=<max>] [-s <setpoint>] [-c <max_charge>] [-d <max_discharge>] [-n <fcr_n_power>] [-u <fcr_d_up_power>] [-w <fcr_d_down_power>] [-f <ffr_power>] [-i <idle_threshold_power>] [-r <discharge_threshold_power>] [-t <freq_test_sequence>] [--fcr_start_from=<fcr_start_from>] [-l <import_limit>] [-x <export_limit>] [--main_fuse=<main_fuse>] [--charge_ramp_up=<charge_ramp_up>] [--discharge_ramp_up=<discharge_ramp_up>] [--import_energy_limit=<import_energy_limit>] [--import_energy_limit_from=<import_energy_limit_from>] [--import_energy_limit_to=<import_energy_limit_to>] [--import_energy_max_compensation=<import_energy_max_compensation>] [--export_energy_limit=<export_energy_limit>] [--export_energy_limit_from=<export_energy_limit_from>] [--export_energy_limit_to=<export_energy_limit_to>] [--export_energy_max_compensation=<export_energy_max_compensation>]
  Add a schedule to the list
        <type>  0 = idle, 1 = inv-charge , 2 = inv-discharge, 3 = grid-charge, 4 = grid-discharge, 5 = grid-charge/discharge, 6 = freq-reserve
  --from=<from>  from time (YYYY-MM-DDTHH:mm:ss)
     --to=<to>  to time (YYYY-MM-DDTHH:mm:ss)
   --min=<min>  Min soc
   --max=<max>  Max soc
  -s, --setpoint=<setpoint>  Power setpoint
  -c, --max_charge=<max_charge>  Max charge power
  -d, --max_discharge=<max_discharge>  Max discharge power
  -n, --fcr_n_power=<fcr_n_power>  FCR-N maximum power
  -u, --fcr_d_up_power=<fcr_d_up_power>  FCR-D-UP maximum power
  -w, --fcr_d_down_power=<fcr_d_down_power>  FCR-D-DOWN maximum power
  -f, --ffr_power=<ffr_power>  FFR maximum power
  -m, --use_ffr_custom_trig_freq  Use custom trigger frequency for FFR set in parameters
  -a, --ffr_rearm  Rearm FFR after ffr_rearm_timeout parameter minutes
  -i, --idle_threshold_power=<idle_threshold_power>  Idle threshold power
  -r, --discharge_threshold_power=<discharge_threshold_power>  Discharge threshold power
  -t, --test_sequence=<freq_test_sequence>  Frequency test sequence: 0 = NONE, 1 = FCR_N_STEP, 2 = FCR_N_STEP_ENDURANCE, 3 = FCR_D_UP_RAMP, 4 = FCR_D_UP_RAMP_ENDURANCE, 5 = FCR_D_DOWN_RAMP, 6 = FCR_D_DOWN_RAMP_ENDURANCE, 7 = FCR_N_SINE, 8 = FCR_D_UP_SINE, 9 = FCR_D_DOWN_SINE, 10 = FCR_N_LER, 11 = FCR_D_UP_LER, 12 = FCR_D_DOWN_LER, 13 = FFR_STEP_49_5, 14 = FFR_STEP_49_6, 15 = FFR_STEP_49_7, 16 = FFR_RAMP
  -e, --test_end_schedule  End schedule after test sequence completion
  -o, --offline  Take inverter offline during idle
  --fcr_start_from=<fcr_start_from>  freq service start time (YYYY-MM-DDTHH:mm:ss)
  -l, --import_limit=<import_limit>  Import limit
  -x, --export_limit=<export_limit>  Export limit
  --main_fuse=<main_fuse>  Main fuse size mA
  --charge_ramp_up=<charge_ramp_up>  Charge ramp up mA/s
  --discharge_ramp_up=<discharge_ramp_up>  Discharge ramp up mA/s
  --import_energy_limit=<import_energy_limit>  Energy import limit Wh
  --import_energy_limit_from=<import_energy_limit_from>  Energy import limit start time (YYYY-MM-DDTHH:mm:ss)
  --import_energy_limit_to=<import_energy_limit_to>  Energy import limit end time (YYYY-MM-DDTHH:mm:ss)
  --import_energy_max_compensation=<import_energy_max_compensation>  Max compensation power for energy import limit W
  --export_energy_limit=<export_energy_limit>  Energy export limit Wh
  --export_energy_limit_from=<export_energy_limit_from>  Energy export limit start time (YYYY-MM-DDTHH:mm:ss)
  --export_energy_limit_to=<export_energy_limit_to>  Energy export limit end time (YYYY-MM-DDTHH:mm:ss)
  --export_energy_max_compensation=<export_energy_max_compensation>  Max compensation power for energy export limit W

sched_clear  
  Clear all schedules

sched_del  <id>
  Delete schedule item
          <id>  Schedule ID

sched_list  
  List all schedules

sched_set  [-maeo] <type> [--from=<from>] [--to=<to>] [--min=<min>] [--max=<max>] [-s <setpoint>] [-c <max_charge>] [-d <max_discharge>] [-n <fcr_n_power>] [-u <fcr_d_up_power>] [-w <fcr_d_down_power>] [-f <ffr_power>] [-i <idle_threshold_power>] [-r <discharge_threshold_power>] [-t <freq_test_sequence>] [--fcr_start_from=<fcr_start_from>] [-l <import_limit>] [-x <export_limit>] [--main_fuse=<main_fuse>] [--charge_ramp_up=<charge_ramp_up>] [--discharge_ramp_up=<discharge_ramp_up>] [--import_energy_limit=<import_energy_limit>] [--import_energy_limit_from=<import_energy_limit_from>] [--import_energy_limit_to=<import_energy_limit_to>] [--import_energy_max_compensation=<import_energy_max_compensation>] [--export_energy_limit=<export_energy_limit>] [--export_energy_limit_from=<export_energy_limit_from>] [--export_energy_limit_to=<export_energy_limit_to>] [--export_energy_max_compensation=<export_energy_max_compensation>]
  Set replacing current schedule
        <type>  0 = idle, 1 = inv-charge , 2 = inv-discharge, 3 = grid-charge, 4 = grid-discharge, 5 = grid-charge/discharge, 6 = freq-reserve
  --from=<from>  from time (YYYY-MM-DDTHH:mm:ss)
     --to=<to>  to time (YYYY-MM-DDTHH:mm:ss)
   --min=<min>  Min soc
   --max=<max>  Max soc
  -s, --setpoint=<setpoint>  Power setpoint
  -c, --max_charge=<max_charge>  Max charge power
  -d, --max_discharge=<max_discharge>  Max discharge power
  -n, --fcr_n_power=<fcr_n_power>  FCR-N maximum power
  -u, --fcr_d_up_power=<fcr_d_up_power>  FCR-D-UP maximum power
  -w, --fcr_d_down_power=<fcr_d_down_power>  FCR-D-DOWN maximum power
  -f, --ffr_power=<ffr_power>  FFR maximum power
  -m, --use_ffr_custom_trig_freq  Use custom trigger frequency for FFR set in parameters
  -a, --ffr_rearm  Rearm FFR after ffr_rearm_timeout parameter minutes
  -i, --idle_threshold_power=<idle_threshold_power>  Idle threshold power
  -r, --discharge_threshold_power=<discharge_threshold_power>  Discharge threshold power
  -t, --test_sequence=<freq_test_sequence>  Frequency test sequence: 0 = NONE, 1 = FCR_N_STEP, 2 = FCR_N_STEP_ENDURANCE, 3 = FCR_D_UP_RAMP, 4 = FCR_D_UP_RAMP_ENDURANCE, 5 = FCR_D_DOWN_RAMP, 6 = FCR_D_DOWN_RAMP_ENDURANCE, 7 = FCR_N_SINE, 8 = FCR_D_UP_SINE, 9 = FCR_D_DOWN_SINE, 10 = FCR_N_LER, 11 = FCR_D_UP_LER, 12 = FCR_D_DOWN_LER, 13 = FFR_STEP_49_5, 14 = FFR_STEP_49_6, 15 = FFR_STEP_49_7, 16 = FFR_RAMP
  -e, --test_end_schedule  End schedule after test sequence completion
  -o, --offline  Take inverter offline during idle
  --fcr_start_from=<fcr_start_from>  freq service start time (YYYY-MM-DDTHH:mm:ss)
  -l, --import_limit=<import_limit>  Import limit
  -x, --export_limit=<export_limit>  Export limit
  --main_fuse=<main_fuse>  Main fuse size mA
  --charge_ramp_up=<charge_ramp_up>  Charge ramp up mA/s
  --discharge_ramp_up=<discharge_ramp_up>  Discharge ramp up mA/s
  --import_energy_limit=<import_energy_limit>  Energy import limit Wh
  --import_energy_limit_from=<import_energy_limit_from>  Energy import limit start time (YYYY-MM-DDTHH:mm:ss)
  --import_energy_limit_to=<import_energy_limit_to>  Energy import limit end time (YYYY-MM-DDTHH:mm:ss)
  --import_energy_max_compensation=<import_energy_max_compensation>  Max compensation power for energy import limit W
  --export_energy_limit=<export_energy_limit>  Energy export limit Wh
  --export_energy_limit_from=<export_energy_limit_from>  Energy export limit start time (YYYY-MM-DDTHH:mm:ss)
  --export_energy_limit_to=<export_energy_limit_to>  Energy export limit end time (YYYY-MM-DDTHH:mm:ss)
  --export_energy_max_compensation=<export_energy_max_compensation>  Max compensation power for energy export limit W

sha1  <path>
  sha1 file
        <path>  File to sha sum

smart  [0|1]
  Activate smart terminal mode

status  
  
system_mode  
  Show current system mode

system_mode_force  <mode>
  Set system mode
        <mode>  0 = init, 1 = production , 2 = operational, 3 = standalone, 4 = service

tasks 
  Get information about running tasks

tasks_load  [<period_ms>]
  Get run-time stats of cpu load

time  'uptime', 'date' or 'ticks' or all (default)
  Get local time

warp_pair_start  [-s <int>] [-e <string>] [-c <int>]
  Enables pairing for X seconds
  -s, --seconds=<int>  Time for pairing to be active
  -e, --euid=<string>  EUID to only allow pairing from
  -c, --channel=<int>  Channel to pair on

warp_pair_stop 
  Disable pairing

webapp_reload 
  Reload webapp

wifi_info 
  Get wifi info

wifi_scan 
  Do wifi scan

worker  [-redno] [-i <i>] [<name>] [-p <i>]
  Control a worker
  -i, --id=<i>  Worker id
        <name>  Worker name
   -r, --reset  Reset worker
  -p, --period=<i>  Set period in ms
  -e, --enable  Enable worker
  -d, --disable  Disable worker
     -n, --run  Schedule worker now
    -o, --once  Run worker once

write_mem  [-bwdq] memory_offset value
  Write memory
  memory_offset  Memory offset
         value  Value to write
    -b, --byte  Write 8 bits
    -w, --word  Write 16 bits
   -d, --dword  Write 32 bits
   -q, --qword  Write 64 bits

Command 'help' executed successfully
```
