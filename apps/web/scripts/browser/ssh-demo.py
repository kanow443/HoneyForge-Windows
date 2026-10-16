"""Own lab transport only. Secrets arrive through stdin and are never logged."""
import json,sys,time,logging
import paramiko
logging.getLogger("paramiko").disabled=True
settings=json.loads(sys.stdin.readline())
client=paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect(settings["host"],port=settings["port"],username=settings["username"],password=settings["password"],look_for_keys=False,allow_agent=False,timeout=20,auth_timeout=20)
    channel=client.invoke_shell()
    for command in ["hostname","date","ls /opt/decoy","echo "+settings["marker"]]:
        channel.send(command+"\n");time.sleep(.6)
    content=("SAFE UI LAB EVIDENCE "+settings["marker"]+"\n").encode()
    sftp=client.open_sftp()
    with sftp.open("/tmp/"+settings["marker"]+".txt","wb") as destination:destination.write(content)
    sftp.close()
    print(json.dumps({"state":"ready","size_bytes":len(content)}),flush=True)
    deadline=time.monotonic()+240;next_command=0
    while client.get_transport().is_active() and time.monotonic()<deadline:
        if channel.recv_ready():channel.recv(8192)
        if time.monotonic()>=next_command:
            try:channel.send("pwd\n")
            except Exception:break
            next_command=time.monotonic()+8
        time.sleep(.2)
    print(json.dumps({"state":"transport_closed","active":client.get_transport().is_active()}),flush=True)
except Exception as error:
    print(json.dumps({"state":"error","error_type":type(error).__name__}),flush=True)
    sys.exit(1)
finally:
    client.close()
