
(* Switch to a private context to protect kernel variables from Clear["Global`*"] *)
Begin["MMATex`Private`"];

Print["[Kernel] Starting Text Protocol Server..."];
$server = SocketOpen[0]; 

If[FailureQ[$server], 
    Print["[Kernel] Failed to open socket."]; Exit[1]
];

$port = $server["DestinationPort"];
If[!IntegerQ[$port], $port = $server["SourcePort"]];

Print["PORT:" <> ToString[$port]];

$buffer = "";

Handler[assoc_] := Module[{client, data, parts, requestStr, json, code, mode, cwd, result, response},
    client = assoc["SourceSocket"];
    data = assoc["Data"];
    
    (* Ensure data is string *)
    If[ByteArrayQ[data], 
        data = ByteArrayToString[data, "UTF-8"]
    ];

    If[!StringQ[data],
        Print["[Kernel] Error: Received non-string data: ", Head[data]];
        Return[];
    ];
    
    $buffer = $buffer <> data;
    
    (* Process all complete messages in buffer *)
    While[StringContainsQ[$buffer, "\n"],
        parts = StringSplit[$buffer, "\n", 2];
        requestStr = parts[[1]];
        $buffer = If[Length[parts] > 1, parts[[2]], ""];
        
        If[StringLength[StringTrim[requestStr]] > 0,
            Print["[Kernel] Request: ", requestStr];
            
            json = ImportString[requestStr, "JSON"];
            
            If[FailureQ[json],
                result = "Error: Invalid JSON";
            ,
                code = "code" /. json;
                mode = "mode" /. json;
                cwd = "cwd" /. json;
                
                (* Execute in Global context *)
                result = Block[{$Context = "Global`"},
                    Module[{val},
                        If[StringQ[cwd] && cwd =!= "", SetDirectory[cwd]];
                        val = Check[ToExpression[code, InputForm], $Failed];
                        
                        If[val === $Failed,
                            "Error: Evaluation failed",
                            If[val === Null,
                                "",
                                If[mode === "latex",
                                    ToString[TeXForm[val]],
                                    ToString[val, InputForm]
                                ]
                            ]
                        ]
                    ]
                ];
            ];
            
            (* Send response as JSON string + newline *)
            response = ExportString[result, "JSON", "Compact" -> True] <> "\n";
            BinaryWrite[client, StringToByteArray[response, "UTF-8"]];
        ];
    ];
];

$listener = SocketListen[$server, Handler];

If[FailureQ[$listener],
    Print["[Kernel] SocketListen failed."]; Exit[1];
];

Print["[Kernel] Ready."];

(* Keep alive *)
While[True, Pause[1]];

End[];

listener = SocketListen[server, Handler];

If[FailureQ[listener],
    Print["[Kernel] SocketListen failed."]; Exit[1];
];

Print["[Kernel] Ready."];

(* Keep alive *)
While[True, Pause[1]];
