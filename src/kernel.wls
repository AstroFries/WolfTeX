
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
                type = "type" /. json;

                If[type === "completion",
                    result = Names["System`*"];
                ,
                If[type === "usage",
                    name = "name" /. json;
                    result = "";
                    If[StringQ[name] && Length[Names[name]] > 0,
                        (* Get usage message *)
                        result = Quiet[MessageName[Evaluate[ToExpression[name]], "usage"]];
                        If[Head[result] === MessageName, 
                            result = ""
                        ,
                            (* Clean up Linear Syntax string to Plain Text *)
                            
                            (* 1. Remove Private Use Characters *)
                            result = StringReplace[result, RegularExpression["[\\x{E000}-\\x{F8FF}]"] -> ""];
                            result = StringReplace[result, {"\!\(\*" -> "", "\!\(" -> ""}];

                            (* 2. Protect semantic commas *)
                            result = StringReplace[result, "\",\"" -> "SEMANTICCOMMA"];
                            
                            (* 3. Remove Formatting Boxes (Pass 1) *)
                            result = StringReplace[result, {
                                "DisplayForm[" -> "",
                                "RowBox[{" -> "", "}]" -> "",
                                "StyleBox[" -> "", 
                                RegularExpression[",\\s*\"T[A-Z]\"\\]"] -> ""
                            }];
                            
                            (* 4. Handle Subscripts/Superscripts (Pass 2) *)
                            result = StringReplace[result, RegularExpression["SubscriptBox\\[\\s*\"([^\"]+)\"\\s*,\\s*\"([^\"]+)\"\\s*\\]"] -> "$1_$2"];
                            result = StringReplace[result, RegularExpression["SuperscriptBox\\[\\s*\"([^\"]+)\"\\s*,\\s*\"([^\"]+)\"\\s*\\]"] -> "$1^$2"];
                            result = StringReplace[result, RegularExpression["SubsuperscriptBox\\[\\s*\"([^\"]+)\"\\s*,\\s*\"([^\"]+)\"\\s*,\\s*\"([^\"]+)\"\\s*\\]"] -> "$1_$2^$3"];

                            (* 5. Remove Remaining Boxes and Artifacts (Pass 3) *)
                            result = StringReplace[result, {
                                "SubscriptBox[" -> "Subscript[",
                                "SuperscriptBox[" -> "Superscript[",
                                "SubsuperscriptBox[" -> "Subsuperscript[",
                                "FractionBox[" -> "Fraction[",
                                "SqrtBox[" -> "Sqrt[",
                                "UnderoverscriptBox[" -> "Underoverscript[",
                                "OverscriptBox[" -> "Overscript[",
                                "UnderscriptBox[" -> "Underscript[",
                                "\"" -> "",          
                                "," -> "",           
                                "\[Integral]" -> "Int",
                                "\[DifferentialD]" -> "d",
                                "\[Element]" -> " in ",
                                "\[Ellipsis]" -> "..."
                            }];
                            
                            (* 6. Restore semantic tokens *)
                            result = StringReplace[result, "SEMANTICCOMMA" -> ","];
                            
                            (* 7. Normalize whitespace, but preserve newlines *)
                            result = StringReplace[result, "\r\n" -> "\n"];
                            result = StringReplace[result, "\r" -> "\n"];
                            result = StringReplace[result, "\t" -> " "];
                            result = StringReplace[result, "\:00a0" -> " "];
                            result = FixedPoint[StringReplace[#, "  " -> " "] &, result];
                            result = FixedPoint[StringReplace[#, "\n\n" -> "\n"] &, result];
                            
                            (* 8. Ensure newlines before usage definitions *)
                            result = StringReplace[result, " " <> name <> " [" -> "\n" <> name <> " ["];
                            result = StringReplace[result, ". " <> name <> " [" -> ".\n" <> name <> " ["];
                            
                            (* Cleanup *)
                            result = FixedPoint[StringReplace[#, "\n\n" -> "\n"] &, result];
                            result = StringReplace[result, "\n " -> "\n"];

                            (* 9. Final Trim *)
                            result = StringTrim[result];
                        ];
                    ];
                ,
                    code = "code" /. json;
                    mode = "mode" /. json;
                    cwd = "cwd" /. json;
                    filename = "filename" /. json;
                    
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
                                        (* If evaluation produced a Graphics-like object, export it to a file
                                           in the current working directory and return a LaTeX includegraphics snippet. *)
                                        If[MemberQ[{Graphics, Graphics3D, GraphicsComplex, GraphicsRow, Image}, Head[val]],
                                            Module[{uuid, fname, exportOK, imgDir, relPath},
                                                uuid = CreateUUID[];
                                                
                                                (* Determine image directory: wolf_image/filename_without_ext/ *)
                                                imgDir = FileNameJoin[{"wolf_image", FileBaseName[filename]}];
                                                
                                                (* Create directory if it doesn't exist *)
                                                If[!DirectoryQ[imgDir], CreateDirectory[imgDir, CreateIntermediateDirectories -> True]];
                                                
                                                fname = FileNameJoin[{imgDir, "plot_" <> uuid <> ".png"}];
                                                relPath = fname; (* Since we are in cwd, this relative path is correct for LaTeX *)
                                                
                                                exportOK = Quiet[Check[Export[fname, val, ImageResolution -> 150], $Failed]];
                                                If[exportOK === $Failed,
                                                    (* Fallback to TeXForm if export failed *)
                                                    ToString[TeXForm[val]],
                                                    (* Return a LaTeX includegraphics command pointing to the file name (relative) *)
                                                    "\\includegraphics{" <> relPath <> "}"
                                                ]
                                            ],
                                            (* Not a graphics object: fall back to TeXForm *)
                                            ToString[TeXForm[val]]
                                        ],
                                        ToString[val, InputForm]
                                    ]
                                ]
                            ]
                        ]
                    ];
                ];
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
