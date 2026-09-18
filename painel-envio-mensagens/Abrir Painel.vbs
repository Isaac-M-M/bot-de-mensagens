' Abre o Painel de Envio de Mensagens sem mostrar nenhuma janela de comando.
' De DOIS CLIQUES neste arquivo (ou num atalho dele na Area de Trabalho)
' para iniciar o painel normalmente.
'
' Tudo que aparecer no terminal fica registrado em "painel-log.txt",
' nesta mesma pasta - se algo nao funcionar, esse arquivo ajuda a entender
' o que aconteceu.

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strPath

' Repare que NAO colocamos o caminho da pasta dentro do comando abaixo -
' isso e de proposito, pra nunca quebrar mesmo se a pasta tiver espacos,
' parenteses ou acentos no nome. O WshShell ja sabe onde estamos por
' causa do CurrentDirectory acima.
WshShell.Run "cmd /c node launcher.js >> painel-log.txt 2>&1", 0, False
